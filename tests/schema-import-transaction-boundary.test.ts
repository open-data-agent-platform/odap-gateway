import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { D1Database, D1Result } from "../lib/d1";
import { importSchemaCatalog, type SchemaImportTableInput } from "../lib/admin-store";
import { createSessionCookie, signAuthPayload } from "../lib/auth";
import * as bigquery from "../lib/bigquery";
import { adminAuthority } from "./fixtures/admin-authority";
import worker from "../worker";
const actor = {provider:"google" as const,providerId:"actor",email:"actor@example.test"};

const input: {workspace:string;tables:SchemaImportTableInput[]} = {workspace:"fixture",tables:[{
  workspace:"fixture",name:"fixture.orders",description:"Local table",rowCount:1,
  fields:[{name:"contact",type:"STRING",mode:"NULLABLE"}]
}]};
const confirmed = (): D1Result[] => [
  {success:true,results:[{id:"synthetic-audit"}]}, {success:true,results:[{confirmed:1}]},
  {success:true,results:[{id:"legacy-table"}]}, {success:true,results:[{confirmed:1}]},
  {success:true,results:[{id:"historical-field",table_id:"legacy-table",field_name:"contact"}]},
  {success:true,results:[{confirmed:1}]}
];
function fixture(result: unknown = confirmed()) {
  const authority = adminAuthority("google","actor","actor@example.test");
  const run = vi.fn(async () => ({success:true}));
  const prepare = vi.fn((query: string) => {
    if (query === "SELECT role,email FROM users WHERE id=? AND provider=? AND provider_id=?") return authority.prepare(query);
    const statement = {bind:() => statement,run,first:async () => ({id:"legacy-table"}),all:async () => ({success:true,results:[]})};
    return statement;
  });
  const batch = vi.fn(async () => result as D1Result[]);
  return {db:{prepare,batch} as D1Database,prepare,run,batch};
}

describe("schema import acknowledgment boundary",() => {
  beforeEach(() => {
    vi.spyOn(crypto,"randomUUID").mockReturnValue("synthetic-audit");
    vi.stubGlobal("fetch",vi.fn(async () => {throw new Error("Unexpected network call");}));
    vi.spyOn(console,"error").mockImplementation(() => {});
  });
  afterEach(() => {vi.restoreAllMocks();vi.unstubAllGlobals();});

  it.each([undefined,null,false,true,{},"batch",0])("refuses noncallable transactions %j without preparing or falling back",async value => {
    const primary = fixture(), fallback = fixture();
    Object.assign(primary.db,{batch:value});
    expect(await importSchemaCatalog({ODAP_GATEWAY_DB:primary.db,DB:fallback.db},input,actor))
      .toMatchObject({ok:false,status:503,code:"schema_import_transaction_unavailable"});
    expect(primary.prepare).not.toHaveBeenCalled();
    expect(fallback.prepare).not.toHaveBeenCalled();
  });

  it.each([undefined,null,{},[],[confirmed()[0]],[...confirmed(),confirmed()[0]]])(
    "refuses malformed transaction results %j",async value => {
      const primary = fixture(), fallback = fixture();
      primary.batch.mockResolvedValue(value as D1Result[]);
      await expect(importSchemaCatalog({ODAP_GATEWAY_DB:primary.db,DB:fallback.db},input,actor))
        .rejects.toThrow("Schema import transaction not confirmed");
      expect(primary.batch).toHaveBeenCalledTimes(1);
      expect(fallback.prepare).not.toHaveBeenCalled();
    });

  describe.each([0,1,2,3,4,5])("statement result %i",index => {
    it.each([null,{}, {success:false,results:[]}, {results:[]}, {success:true},
      {success:true,results:{}}, {success:true,results:[]}, {success:true,results:[{},{}]}])(
      "rejects an unconfirmed envelope %j",async value => {
        const results = confirmed();
        results[index] = value as D1Result;
        const {db,batch} = fixture(results);
        await expect(importSchemaCatalog({DB:db},input,actor))
          .rejects.toThrow("Schema import transaction not confirmed");
        expect(batch).toHaveBeenCalledTimes(1);
      });
    it("rejects a mismatched identity or failed confirmation",async () => {
      const results = confirmed();
      results[index].results = index % 2 ? [{confirmed:0}] : [{id:"other"}];
      await expect(importSchemaCatalog({DB:fixture(results).db},input,actor))
        .rejects.toThrow("Schema import write not confirmed");
    });
  });

  it.each([
    {id:"field",table_id:"other",field_name:"contact"},
    {id:"field",table_id:"legacy-table",field_name:"other"},
    {id:"",table_id:"legacy-table",field_name:"contact"},
    null
  ])("rejects a field acknowledgment with mismatched logical identity %j",async row => {
    const results = confirmed();
    results[4].results = [row as NonNullable<D1Result["results"]>[number]];
    await expect(importSchemaCatalog({DB:fixture(results).db},input,actor))
      .rejects.toThrow("Schema import write not confirmed");
  });

  it("accepts a preserved historical field ID with matching table and field name",async () => {
    const {db,batch,run} = fixture();
    expect(await importSchemaCatalog({DB:db},input,actor))
      .toMatchObject({ok:true,value:{workspace:"fixture",importedTables:1,importedFields:1}});
    expect(run).toHaveBeenCalledTimes(8);
    expect(batch).toHaveBeenCalledTimes(1);
  });

  it.each([
    {}, { pii: 0, queryable: 0 }, { pii: true, queryable: 0 },
    { pii: "1", queryable: 0 }, { pii: 1, queryable: 1 }, { pii: 1, queryable: false }
  ])("rejects an acknowledgment that does not confirm explicit restrictions %j", async flags => {
    const restricted = structuredClone(input);
    Object.assign(restricted.tables[0].fields[0], { pii: true, queryable: false });
    const results = confirmed();
    Object.assign(results[4].results![0], flags);
    const { db, batch } = fixture(results);
    await expect(importSchemaCatalog({ DB: db }, restricted, actor)).rejects.toThrow("Schema import write not confirmed");
    expect(batch).toHaveBeenCalledTimes(1);
  });

  it("accepts confirmed restrictions on the preserved historical field", async () => {
    const restricted = structuredClone(input);
    Object.assign(restricted.tables[0].fields[0], { pii: true, queryable: false });
    const results = confirmed();
    Object.assign(results[4].results![0], { pii: 1, queryable: 0 });
    expect(await importSchemaCatalog({ DB: fixture(results).db }, restricted, actor)).toMatchObject({ ok: true });
  });

  it("returns denial only when all writes are confirmed empty and assertions are confirmed",async () => {
    const results = confirmed();
    for (const index of [0,2,4]) results[index].results = [];
    const {db,batch} = fixture(results);
    expect(await importSchemaCatalog({DB:db},input,actor)).toMatchObject({ok:false,status:403,code:"schema_import_denied"});
    expect(batch).toHaveBeenCalledTimes(1);
  });

  it.each([1,3,5])("rejects unconfirmed assertion %s on an otherwise empty denial",async index => {
    const results = confirmed();
    for (const write of [0,2,4]) results[write].results = [];
    results[index].results = [{confirmed:0}];
    await expect(importSchemaCatalog({DB:fixture(results).db},input,actor)).rejects.toThrow("Schema import transaction not confirmed");
  });

  it("does not retry or fall back after an uncertain transaction failure",async () => {
    const primary = fixture(), fallback = fixture(), error = new Error("Synthetic uncertain commit");
    primary.batch.mockRejectedValue(error);
    await expect(importSchemaCatalog({ODAP_GATEWAY_DB:primary.db,DB:fallback.db},input,actor)).rejects.toBe(error);
    expect(primary.batch).toHaveBeenCalledTimes(1);
    expect(fallback.prepare).not.toHaveBeenCalled();
  });

  it("retains unconfigured and empty input refusals without a batch",async () => {
    const {db,prepare,batch} = fixture();
    expect(await importSchemaCatalog({},input,actor)).toMatchObject({ok:false,code:"storage_not_configured"});
    expect(await importSchemaCatalog({DB:db},{workspace:"fixture",tables:[]},actor))
      .toMatchObject({ok:false,status:400,code:"schema_import_empty"});
    expect(prepare).not.toHaveBeenCalled();
    expect(batch).not.toHaveBeenCalled();
  });

  it.each([false,true])("Worker returns success only for confirmed imported records, confirmed=%s",async valid => {
    const {db} = fixture(valid ? confirmed() : [{success:false,error:"private-import-diagnostic"}]);
    const query = vi.spyOn(bigquery,"runBigQueryQuery").mockResolvedValue({ok:true,totalRows:1,rows:[{
      table_catalog:"fixture-project",table_schema:"fixture",table_name:"orders",table_type:"BASE TABLE",
      column_name:"contact",data_type:"STRING",is_nullable:"YES",ordinal_position:1,policy_tags:null
    }]});
    const secret = "synthetic-import-transaction-cookie";
    const cookie = createSessionCookie(await signAuthPayload({provider:"google",providerId:"actor",role:"admin",
      email:"actor@example.test",name:"Actor",expiresAt:Date.now()+600000},secret));
    const response = await worker.fetch(new Request("https://gateway.test/api/admin/schema-import",{
      method:"POST",headers:{Cookie:cookie},body:JSON.stringify({workspace:"fixture",dataset:"fixture",projectId:"fixture-project"})
    }),{DB:db,GATEWAY_MODE:"demo",AUTH_COOKIE_SECRET:secret,ASSETS:{fetch:async () => {throw new Error("Unexpected assets");}}},
    {waitUntil:() => undefined});
    const body = await response.json();
    expect(query).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
    if (valid) {
      expect(response.status).toBe(200);
      expect(body).toMatchObject({ok:true,import:{importedTables:1,importedFields:1,workspace:"fixture"}});
    } else {
      expect(response.status).toBe(500);
      expect(body).toMatchObject({ok:false,code:"internal_error"});
      expect(body).not.toHaveProperty("import");
      expect(JSON.stringify(body)).not.toContain("private-import-diagnostic");
    }
  });
});
