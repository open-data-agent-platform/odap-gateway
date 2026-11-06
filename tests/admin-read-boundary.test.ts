import { afterEach, describe, expect, it, vi } from "vitest";
import type { D1Database, D1Result } from "../lib/d1";
import { getAdminState, getSchemaPolicyCatalog } from "../lib/admin-store";
import { evaluateSchemaPolicy } from "../lib/schema-policy";
import { createSessionCookie, signAuthPayload } from "../lib/auth";
import { adminAuthority } from "./fixtures/admin-authority";
import worker from "../worker";

const tables = ["users","feature_flags","workspaces","run_reviews","schema_tables","schema_fields","audit_events"];
const rows: Record<string, Record<string, unknown>[]> = {
  users:[{id:"google:actor",provider:"google",provider_id:"actor",email:"actor@example.test",name:"Actor",avatar_url:null,
    role:"admin",last_login_at:"fixture",created_at:"fixture",updated_at:"fixture"}],
  feature_flags:[{id:"flag",name:"Fixture flag",description:"Local only",status:"paused",environment:"staging",rollout:0,owner:"Owner",updated_at:"fixture"}],
  workspaces:[{workspace:"fixture",owner:"Owner",plan:"Team",run_access:"blocked"}],
  run_reviews:[{id:"review",workspace:"fixture",query_type:"Preview",status:"needs_approval",estimated_cost_usd:1,scanned_bytes:10,submitted_at:"fixture"}],
  schema_tables:[{id:"table",workspace:"fixture",table_name:"fixture.orders",description:"Fixture table",row_count:0,updated_at:"fixture"}],
  schema_fields:[{id:"field",table_id:"table",field_name:"contact",field_type:"STRING",mode:"NULLABLE",description:"Contact",pii:1,queryable:0,used_in_examples:0,updated_at:"fixture"}],
  audit_events:[{id:"audit",actor_email:"actor@example.test",action:"fixture.action",target:"fixture",metadata_json:'{"source":"fixture"}',created_at:"fixture"}]
};

function fixture(override: (table: string) => unknown = table => ({success:true,results:rows[table]})) {
  const run = vi.fn(async () => ({success:true}));
  const all = vi.fn(async (query: string): Promise<D1Result> => {
    const table = /FROM ([a-z_]+)/.exec(query)?.[1];
    if (!table || !tables.includes(table)) throw new Error("Unexpected list query");
    return await override(table) as D1Result;
  });
  const authority = adminAuthority("google","actor","actor@example.test");
  const prepare = vi.fn((query: string) => {
    if (query === "SELECT role,email FROM users WHERE id=? AND provider=? AND provider_id=?") return authority.prepare(query);
    const statement = {bind:() => statement,run,all:() => all(query),first:async () => {throw new Error("Unexpected detail read");}};
    return statement;
  });
  return {db:{prepare} as D1Database,all,prepare,run};
}

describe("confirmed administrator list reads",() => {
  afterEach(() => {vi.restoreAllMocks();vi.unstubAllGlobals();});

  it("baseline: refuses a failed feature list instead of persisted empty state",async () => {
    const {db} = fixture(table => table === "feature_flags" ? {success:false,results:[]} : {success:true,results:rows[table]});
    await expect(getAdminState({DB:db})).rejects.toThrow();
  });

  it("baseline: refuses missing audit results instead of no history",async () => {
    const {db} = fixture(table => table === "audit_events" ? {success:true} : {success:true,results:rows[table]});
    await expect(getAdminState({DB:db})).rejects.toThrow();
  });

  it("baseline: refuses a catalog whose fields did not load",async () => {
    const {db} = fixture(table => table === "schema_fields" ? {success:false,results:[]} : {success:true,results:rows[table]});
    await expect(getSchemaPolicyCatalog({DB:db})).rejects.toThrow();
  });

  describe.each(tables)("%s list",table => {
    it.each([undefined,null,{}, {success:false,results:[]}, {results:[]}, {success:true},
      {success:true,results:null}, {success:true,results:{}}, {success:"true",results:[]}])(
      "rejects an unconfirmed or malformed envelope: %j",async result => {
        const primary = fixture(name => name === table ? result : {success:true,results:rows[name]}), fallback = fixture();
        await expect(getAdminState({ODAP_GATEWAY_DB:primary.db,DB:fallback.db})).rejects.toThrow("Admin read not confirmed");
        expect(fallback.prepare).not.toHaveBeenCalled();
        expect(primary.all.mock.calls.filter(([query]) => query.includes(`FROM ${table}`))).toHaveLength(1);
      });

    it("rejects failed results even if they contain usable rows",async () => {
      const {db} = fixture(name => ({success:name !== table,results:rows[name]}));
      await expect(getAdminState({DB:db})).rejects.toThrow("Admin read not confirmed");
    });

    it("propagates an exception without retrying or falling back",async () => {
      const failure = new Error("Synthetic read failure"), fallback = fixture();
      const primary = fixture(name => {if (name === table) throw failure;return {success:true,results:rows[name]};});
      await expect(getAdminState({ODAP_GATEWAY_DB:primary.db,DB:fallback.db})).rejects.toBe(failure);
      expect(fallback.prepare).not.toHaveBeenCalled();
      expect(primary.all.mock.calls.filter(([query]) => query.includes(`FROM ${table}`))).toHaveLength(1);
    });
  });

  it.each(["schema_tables","schema_fields"])("does not return a partial catalog or policy evaluation when %s fails",async target => {
    const {db} = fixture(name => ({success:name !== target,results:rows[name]}));
    await expect(getSchemaPolicyCatalog({DB:db})).rejects.toThrow("Admin read not confirmed");
    await expect(evaluateSchemaPolicy({DB:db},{workspace:"fixture",sql:"SELECT contact FROM fixture.orders"}))
      .rejects.toThrow("Admin read not confirmed");
  });

  it("accepts confirmed empty lists and an empty catalog without examples",async () => {
    const {db} = fixture(() => ({success:true,results:[]}));
    const state = await getAdminState({DB:db});
    expect(state.storage).toMatchObject({configured:true,mode:"d1",binding:"DB"});
    for (const list of [state.users,state.featureFlags,state.workspaceAllowlist,state.reviewQueue,state.schemaCatalog,state.auditEvents]) {
      expect(list).toEqual([]);
    }
    expect(await getSchemaPolicyCatalog({DB:db})).toEqual({tables:[],source:"d1",storageBinding:"DB"});
  });

  it("retains successful stored projections, field policy and audit metadata",async () => {
    const {db} = fixture(), state = await getAdminState({ODAP_GATEWAY_DB:db});
    expect(state.users).toEqual([expect.objectContaining({id:"google:actor",role:"admin"})]);
    expect(state.featureFlags).toEqual([expect.objectContaining({id:"flag",rollout:0})]);
    expect(state.workspaceAllowlist).toEqual([{workspace:"fixture",owner:"Owner",plan:"Team",runAccess:"blocked"}]);
    expect(state.reviewQueue).toEqual([expect.objectContaining({id:"review",status:"needs_approval"})]);
    expect(state.auditEvents).toEqual([expect.objectContaining({id:"audit",metadata:{source:"fixture"}})]);
    expect(state.schemaCatalog).toEqual([expect.objectContaining({id:"table",fields:[expect.objectContaining({id:"field",pii:true,queryable:false})]})]);
    expect((await getSchemaPolicyCatalog({ODAP_GATEWAY_DB:db})).tables).toEqual(state.schemaCatalog);
  });

  it.each(["feature_flags","schema_fields","audit_events"])("returns a controlled Worker failure, not partial state, for %s",async target => {
    const {db} = fixture(name => name === target ? {success:false,results:[],error:"private-read-diagnostic"} : {success:true,results:rows[name]});
    const secret = "synthetic-admin-list-cookie";
    const cookie = createSessionCookie(await signAuthPayload({provider:"google",providerId:"actor",email:"actor@example.test",
      name:"Actor",role:"admin",expiresAt:Date.now()+600000},secret));
    vi.stubGlobal("fetch",vi.fn(async () => {throw new Error("Unexpected remote request");}));
    vi.spyOn(console,"error").mockImplementation(() => {});
    const response = await worker.fetch(new Request("https://gateway.test/api/admin/state",{headers:{Cookie:cookie}}),
      {DB:db,AUTH_COOKIE_SECRET:secret,ASSETS:{fetch:async () => {throw new Error("Unexpected asset request");}}},
      {waitUntil:() => {throw new Error("Unexpected background task");}});
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toMatchObject({ok:false,code:"internal_error"});
    expect(body).not.toHaveProperty("state");
    expect(JSON.stringify(body)).not.toContain("private-read-diagnostic");
    expect(fetch).not.toHaveBeenCalled();
  });
});
