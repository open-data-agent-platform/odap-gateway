import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionCookie, signAuthPayload } from "../lib/auth";
import { ensureAdminSchema, updateSchemaFieldPolicy } from "../lib/admin-store";
import { jobSqlite, jobTransactionalDatabase } from "./fixtures/job-sqlite";
import worker from "../worker";

let dir: string, file: string, baseline: string, cookie: string;
let beforeWrite: (() => Promise<void>) | null = null;
const base = jobTransactionalDatabase(() => file);
const db = {...base,batch: async (statements: Parameters<NonNullable<typeof base.batch>>[0]) => {
  const fn = beforeWrite;
  beforeWrite = null;
  await fn?.();
  return base.batch!(statements);
}};
const env = {AUTH_COOKIE_SECRET:"synthetic-schema-policy",DB:db,
  ASSETS:{fetch:async () => {throw new Error("Unexpected asset request");}}};
const sql = (query: string) => jobSqlite(file,"run",query);
const policy = () => jobSqlite(file,"readonly-first","SELECT queryable,pii FROM schema_fields WHERE id='sensitive-field'");
const auditCount = () => jobSqlite(file,"readonly-first","SELECT count(*) n FROM audit_events WHERE action='schema_field.policy_updated'");
const request = (body: Record<string,unknown> = {queryable:true,pii:false}) => new Request(
  "https://gateway.test/api/admin/schema-fields/sensitive-field",{
    method:"PATCH",headers:{Cookie:cookie,"Content-Type":"application/json"},body:JSON.stringify(body)
  });
const submit = (input = request()) => worker.fetch(input,env,{waitUntil:() => {throw new Error("Unexpected background task");}});

describe("current authority and atomic audit at schema policy mutation",() => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(),"odap-schema-policy-"));
    file = baseline = join(dir,"baseline.sqlite");
    await ensureAdminSchema(db);
    await sql(`INSERT INTO users(id,provider,provider_id,email,name,role,last_login_at,created_at,updated_at)
      VALUES ('google:actor','google','actor','actor@example.test','Actor','admin','fixture','fixture','fixture')`);
    await sql(`INSERT INTO schema_tables VALUES ('test-table','test-workspace','orders','Synthetic orders',0,'fixture')`);
    await sql(`INSERT INTO schema_fields VALUES ('sensitive-field','test-table','customer_email','STRING',
      'NULLABLE','Synthetic contact',1,0,0,'fixture')`);
    cookie = createSessionCookie(await signAuthPayload({provider:"google",providerId:"actor",email:"actor@example.test",
      name:"Actor",role:"admin",expiresAt:Date.now()+600000},env.AUTH_COOKIE_SECRET));
  },20000);
  beforeEach(async () => {
    file = join(dir,"case.sqlite");
    await copyFile(baseline,file);
    beforeWrite = null;
    vi.stubGlobal("fetch",vi.fn(async () => {throw new Error("Unexpected network call");}));
    vi.spyOn(console,"error").mockImplementation(() => {});
  });
  afterEach(() => {vi.unstubAllGlobals();vi.restoreAllMocks();});
  afterAll(async () => {if (dir) await rm(dir,{recursive:true,force:true});});

  it("refuses a policy relaxation after the actor is demoted during body parsing",async () => {
    const input = request(), parse = input.json.bind(input);
    input.json = async () => {
      await sql("UPDATE users SET role='member' WHERE id='google:actor'");
      return parse();
    };
    const response = await submit(input);
    expect({status:response.status,policy:await policy()}).toEqual({status:403,policy:{queryable:0,pii:1}});
    expect(await auditCount()).toEqual({n:0});
    expect(fetch).not.toHaveBeenCalled();
  },20000);

  it("leaves policy unchanged when its required audit cannot be persisted",async () => {
    await sql(`CREATE TRIGGER fail_policy_audit BEFORE INSERT ON audit_events
      WHEN NEW.action='schema_field.policy_updated' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END`);
    const before = await readFile(file);
    expect((await submit()).status).toBe(500);
    expect(await policy()).toEqual({queryable:0,pii:1});
    expect(await auditCount()).toEqual({n:0});
    expect(await readFile(file)).toEqual(before);
  },20000);

  it.each([
    ["demoted actor","UPDATE users SET role='member' WHERE id='google:actor'"],
    ["removed actor","DELETE FROM users WHERE id='google:actor'"],
    ["rebound subject","UPDATE users SET provider_id='replacement' WHERE id='google:actor'"],
    ["rebound provider","UPDATE users SET provider='github' WHERE id='google:actor'"],
    ["changed audit contact","UPDATE users SET email='renamed@example.test' WHERE id='google:actor'"]
  ])("refuses %s after the field snapshot was read",async (_label,change) => {
    let before: Buffer | undefined;
    beforeWrite = async () => {await sql(change); before = await readFile(file);};
    const response = await submit();
    expect(beforeWrite).toBeNull();
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({code:"schema_field_update_denied"});
    expect(await policy()).toEqual({queryable:0,pii:1});
    expect(await auditCount()).toEqual({n:0});
    expect(await readFile(file)).toEqual(before);
  },20000);

  it.each([
    ["table association","table_id='other-table'"],
    ["field name","field_name='another_contact'"],
    ["field type","field_type='BYTES'"],
    ["field mode","mode='REQUIRED'"],
    ["description","description='Revised contact policy'"],
    ["PII flag","pii=0"],
    ["queryable flag","queryable=1"],
    ["example policy","used_in_examples=1"],
    ["revision time","updated_at='replacement'"],
    ["removed field",null]
  ])("does not overwrite an intervening change to %s",async (_label,change) => {
    let before: Buffer | undefined;
    beforeWrite = async () => {
      await sql(`INSERT INTO schema_tables VALUES ('other-table','other-workspace','orders','Synthetic',0,'fixture')`);
      await sql(change ? `UPDATE schema_fields SET ${change} WHERE id='sensitive-field'`
        : "DELETE FROM schema_fields WHERE id='sensitive-field'");
      before = await readFile(file);
    };
    const response = await submit();
    expect(response.status).toBe(403);
    expect(beforeWrite).toBeNull();
    expect(await auditCount()).toEqual({n:0});
    expect(await readFile(file)).toEqual(before);
  },20000);

  it("returns the actual field and audits the previous and new policies",async () => {
    const response = await submit();
    expect(response.status).toBe(200);
    const body = await response.json() as {schemaField:{updatedAt:string}};
    expect(body).toMatchObject({ok:true,schemaField:{id:"sensitive-field",name:"customer_email",type:"STRING",
      mode:"NULLABLE",description:"Synthetic contact",queryable:true,pii:false,usedInExamples:false}});
    expect(await policy()).toEqual({queryable:1,pii:0});
    expect(await jobSqlite(file,"readonly-first",`SELECT actor_email,target,metadata_json,created_at
      FROM audit_events WHERE action='schema_field.policy_updated'`)).toEqual({
        actor_email:"actor@example.test",target:"sensitive-field",created_at:body.schemaField.updatedAt,
        metadata_json:JSON.stringify({tableId:"test-table",field:"customer_email",previousQueryable:false,
          previousPii:true,queryable:true,pii:false})
      });
    expect(fetch).not.toHaveBeenCalled();
  },20000);

  it("retains the other flag when the request changes only one policy",async () => {
    expect((await submit(request({queryable:true}))).status).toBe(200);
    expect(await policy()).toEqual({queryable:1,pii:1});
    expect(await auditCount()).toEqual({n:1});
  },20000);

  it.each([
    ["audit insert","BEFORE INSERT ON audit_events WHEN NEW.action='schema_field.policy_updated'",403],
    ["policy update","BEFORE UPDATE OF queryable,pii ON schema_fields",500]
  ])("keeps neither side when the %s is ignored",async (_label,clause,status) => {
    await sql(`CREATE TRIGGER ignored_policy_write ${clause} BEGIN SELECT RAISE(IGNORE); END`);
    expect((await submit()).status).toBe(status);
    expect(await policy()).toEqual({queryable:0,pii:1});
    expect(await auditCount()).toEqual({n:0});
  },20000);

  it("rolls back its tentative audit when the policy statement aborts",async () => {
    await sql(`CREATE TRIGGER failed_policy_write BEFORE UPDATE OF queryable,pii ON schema_fields
      BEGIN SELECT RAISE(ABORT,'synthetic policy failure'); END`);
    const before = await readFile(file);
    expect((await submit()).status).toBe(500);
    expect(await policy()).toEqual({queryable:0,pii:1});
    expect(await auditCount()).toEqual({n:0});
    expect(await readFile(file)).toEqual(before);
  },20000);

  it.each([false,true])("never deletes historical audit on ID collision, revoked=%s",async revoked => {
    await sql(`INSERT INTO audit_events VALUES ('collision','prior@example.test','schema_field.policy_updated',
      'prior-target','{}','prior-time')`);
    let before = await readFile(file);
    beforeWrite = async () => {
      if (revoked) await sql("DELETE FROM users WHERE id='google:actor'");
      before = await readFile(file);
    };
    vi.spyOn(crypto,"randomUUID").mockReturnValue("collision");
    expect((await submit()).status).toBe(500);
    expect(await policy()).toEqual({queryable:0,pii:1});
    expect(await auditCount()).toEqual({n:1});
    expect(await readFile(file)).toEqual(before);
  },20000);

  it("refuses missing transactional storage without schema writes or binding fallback",async () => {
    const prepare = vi.fn();
    const before = await readFile(file);
    expect(await updateSchemaFieldPolicy({ODAP_GATEWAY_DB:{prepare},DB:db},"sensitive-field",{queryable:true},
      {provider:"google",providerId:"actor",email:"actor@example.test"}))
      .toMatchObject({ok:false,status:503,code:"schema_policy_transaction_unavailable"});
    expect(prepare).not.toHaveBeenCalled();
    expect(await readFile(file)).toEqual(before);
  });

  it("does not retry a transaction whose committed acknowledgment is lost",async () => {
    const batch = vi.spyOn(db,"batch").mockImplementation(async statements => {
      await base.batch!(statements);
      throw new Error("Synthetic acknowledgment loss");
    });
    expect((await submit()).status).toBe(500);
    expect(await policy()).toEqual({queryable:1,pii:0});
    expect(await auditCount()).toEqual({n:1});
    expect(batch).toHaveBeenCalledTimes(1);
  },20000);

  it("rejects an unsuccessful batch acknowledgment",async () => {
    vi.spyOn(db,"batch").mockResolvedValue([
      {success:true,results:[]},{success:false,results:[]},{success:true,results:[]}
    ]);
    const before = await readFile(file);
    expect((await submit()).status).toBe(500);
    expect(await readFile(file)).toEqual(before);
  },20000);

  it("admits one audited change when competing requests share a field snapshot",async () => {
    let release!: () => void;
    const ready = new Promise<void>(resolve => {release=resolve;});
    let arrivals = 0;
    vi.spyOn(db,"batch").mockImplementation(async statements => {
      if (++arrivals === 2) release();
      await ready;
      return base.batch!(statements);
    });
    const responses = await Promise.all([submit(),submit(request({queryable:false,pii:false}))]);
    expect(responses.map(response => response.status).sort()).toEqual([200,403]);
    expect(await auditCount()).toEqual({n:1});
    const stored = await policy();
    expect(await jobSqlite(file,"readonly-first",`SELECT json_extract(metadata_json,'$.queryable') queryable,
      json_extract(metadata_json,'$.pii') pii FROM audit_events WHERE action='schema_field.policy_updated'`))
      .toEqual(stored);
  },20000);
});
