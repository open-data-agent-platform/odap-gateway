import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionCookie, signAuthPayload } from "../lib/auth";
import { ensureAdminSchema, updateFeatureRollout } from "../lib/admin-store";
import { jobSqlite, jobTransactionalDatabase } from "./fixtures/job-sqlite";
import worker from "../worker";
import { withBodyReadHook } from "./fixtures/request-body-hook";

let dir: string, file: string, baseline: string, cookie: string;
let beforeWrite: (() => Promise<void>) | null = null;
const base = jobTransactionalDatabase(() => file);
const db = {...base,batch: async (statements: Parameters<NonNullable<typeof base.batch>>[0]) => {
  const fn = beforeWrite;
  beforeWrite = null;
  await fn?.();
  return base.batch!(statements);
}};
const actor = {provider:"google" as const,providerId:"actor",email:"actor@example.test"};
const env = {AUTH_COOKIE_SECRET:"synthetic-feature-rollout",DB:db,
  ASSETS:{fetch:async () => {throw new Error("Unexpected asset request");}}};
const sql = (query: string) => jobSqlite(file,"run",query);
const flag = () => jobSqlite(file,"readonly-first","SELECT rollout,status FROM feature_flags WHERE id='fixture-flag'");
const auditCount = () => jobSqlite(file,"readonly-first","SELECT count(*) n FROM audit_events WHERE action='feature_flag.rollout_updated'");
const request = (rollout: unknown = 100) => new Request("https://gateway.test/api/admin/feature-flags/fixture-flag",{
  method:"PATCH",headers:{Cookie:cookie,Origin:"https://gateway.test","Content-Type":"application/json"},body:JSON.stringify({rollout})
});
const submit = (input = request()) => worker.fetch(input,env,{waitUntil:() => {throw new Error("Unexpected background task");}});

describe("current authority and atomic audit at feature rollout mutation",() => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(),"odap-feature-rollout-"));
    file = baseline = join(dir,"baseline.sqlite");
    await ensureAdminSchema(db);
    await sql(`INSERT INTO users(id,provider,provider_id,email,name,role,last_login_at,created_at,updated_at)
      VALUES ('google:actor','google','actor','actor@example.test','Actor','admin','fixture','fixture','fixture')`);
    await sql(`INSERT INTO feature_flags VALUES ('fixture-flag','Synthetic flag','Local configuration only',
      'paused','staging',0,'fixture-owner','fixture')`);
    cookie = createSessionCookie(await signAuthPayload({...actor,name:"Actor",role:"admin",
      expiresAt:Date.now()+600000},env.AUTH_COOKIE_SECRET));
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

  it("refuses a rollout after the actor is demoted during request-body parsing",async () => {
    const revoke = vi.fn(() => sql("UPDATE users SET role='member' WHERE id='google:actor'"));
    const response = await submit(withBodyReadHook(request(), revoke));
    expect(revoke).toHaveBeenCalledOnce();
    expect({status:response.status,flag:await flag()})
      .toEqual({status:403,flag:{rollout:0,status:"paused"}});
    expect(await auditCount()).toEqual({n:0});
  },20000);

  it("retains the original flag when its required audit insert fails",async () => {
    await sql(`CREATE TRIGGER fail_rollout_audit BEFORE INSERT ON audit_events
      WHEN NEW.action='feature_flag.rollout_updated' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END`);
    const before = await readFile(file);
    expect((await submit()).status).toBe(500);
    expect(await flag()).toEqual({rollout:0,status:"paused"});
    expect(await auditCount()).toEqual({n:0});
    expect(await readFile(file)).toEqual(before);
  },20000);

  it.each([
    ["demoted actor","UPDATE users SET role='member' WHERE id='google:actor'"],
    ["removed actor","DELETE FROM users WHERE id='google:actor'"],
    ["rebound subject","UPDATE users SET provider_id='replacement' WHERE id='google:actor'"],
    ["rebound provider","UPDATE users SET provider='github' WHERE id='google:actor'"],
    ["changed audit contact","UPDATE users SET email='renamed@example.test' WHERE id='google:actor'"]
  ])("refuses %s after the flag snapshot was read",async (_label,change) => {
    let before: Buffer | undefined;
    beforeWrite = async () => {await sql(change); before = await readFile(file);};
    const response = await submit();
    expect(beforeWrite).toBeNull();
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({code:"feature_rollout_update_denied"});
    expect(await flag()).toEqual({rollout:0,status:"paused"});
    expect(await auditCount()).toEqual({n:0});
    expect(await readFile(file)).toEqual(before);
  },20000);

  it.each([
    ["name","name='Replacement flag'"],
    ["description","description='Revised behavior'"],
    ["status","status='guarded'"],
    ["environment","environment='production'"],
    ["rollout","rollout=25"],
    ["owner","owner='another-owner'"],
    ["revision time","updated_at='replacement'"],
    ["removed flag",null]
  ])("does not overwrite an intervening change to %s",async (_label,change) => {
    let before: Buffer | undefined;
    beforeWrite = async () => {
      await sql(change ? `UPDATE feature_flags SET ${change} WHERE id='fixture-flag'`
        : "DELETE FROM feature_flags WHERE id='fixture-flag'");
      before = await readFile(file);
    };
    const response = await submit();
    expect(response.status).toBe(403);
    expect(beforeWrite).toBeNull();
    expect(await auditCount()).toEqual({n:0});
    expect(await readFile(file)).toEqual(before);
  },20000);

  it.each([[0,"paused"],[50,"guarded"],[100,"enabled"]] as const)(
    "returns the actual %s percent configuration and its matching audit",async (rollout,status) => {
      const response = await submit(request(rollout));
      expect(response.status).toBe(200);
      const body = await response.json() as {featureFlag:{updatedAt:string}};
      expect(body).toMatchObject({ok:true,featureFlag:{id:"fixture-flag",name:"Synthetic flag",
        description:"Local configuration only",environment:"staging",owner:"fixture-owner",rollout,status}});
      expect(await flag()).toEqual({rollout,status});
      expect(await jobSqlite(file,"readonly-first",`SELECT actor_email,target,metadata_json,created_at
        FROM audit_events WHERE action='feature_flag.rollout_updated'`)).toEqual({
          actor_email:"actor@example.test",target:"fixture-flag",created_at:body.featureFlag.updatedAt,
          metadata_json:JSON.stringify({environment:"staging",owner:"fixture-owner",previousRollout:0,
            previousStatus:"paused",rollout,status})
        });
      expect(fetch).not.toHaveBeenCalled();
    },20000);

  it.each([-1,101,0.5,"100"])("rejects invalid rollout %s before a transaction",async rollout => {
    const batch = vi.spyOn(db,"batch");
    const before = await readFile(file);
    expect((await submit(request(rollout))).status).toBe(400);
    expect(batch).not.toHaveBeenCalled();
    expect(await readFile(file)).toEqual(before);
  },20000);

  it.each([
    ["audit insert","BEFORE INSERT ON audit_events WHEN NEW.action='feature_flag.rollout_updated'",403],
    ["flag update","BEFORE UPDATE OF rollout,status ON feature_flags",500]
  ])("keeps neither side when the %s is ignored",async (_label,clause,status) => {
    await sql(`CREATE TRIGGER ignored_rollout_write ${clause} BEGIN SELECT RAISE(IGNORE); END`);
    expect((await submit()).status).toBe(status);
    expect(await flag()).toEqual({rollout:0,status:"paused"});
    expect(await auditCount()).toEqual({n:0});
  },20000);

  it("rolls back its tentative audit when the flag statement aborts",async () => {
    await sql(`CREATE TRIGGER failed_rollout_write BEFORE UPDATE OF rollout,status ON feature_flags
      BEGIN SELECT RAISE(ABORT,'synthetic rollout failure'); END`);
    const before = await readFile(file);
    expect((await submit()).status).toBe(500);
    expect(await flag()).toEqual({rollout:0,status:"paused"});
    expect(await auditCount()).toEqual({n:0});
    expect(await readFile(file)).toEqual(before);
  },20000);

  it.each([false,true])("never deletes historical audit on ID collision, revoked=%s",async revoked => {
    await sql(`INSERT INTO audit_events VALUES ('collision','prior@example.test','feature_flag.rollout_updated',
      'prior-target','{}','prior-time')`);
    let before = await readFile(file);
    beforeWrite = async () => {
      if (revoked) await sql("DELETE FROM users WHERE id='google:actor'");
      before = await readFile(file);
    };
    vi.spyOn(crypto,"randomUUID").mockReturnValue("collision");
    expect((await submit()).status).toBe(500);
    expect(await flag()).toEqual({rollout:0,status:"paused"});
    expect(await auditCount()).toEqual({n:1});
    expect(await readFile(file)).toEqual(before);
  },20000);

  it("refuses missing transactional storage without schema writes or binding fallback",async () => {
    const prepare = vi.fn();
    const before = await readFile(file);
    expect(await updateFeatureRollout({ODAP_GATEWAY_DB:{prepare},DB:db},"fixture-flag",100,actor))
      .toMatchObject({ok:false,status:503,code:"feature_rollout_transaction_unavailable"});
    expect(prepare).not.toHaveBeenCalled();
    expect(await readFile(file)).toEqual(before);
  });

  it("does not retry a transaction whose committed acknowledgment is lost",async () => {
    const batch = vi.spyOn(db,"batch").mockImplementation(async statements => {
      await base.batch!(statements);
      throw new Error("Synthetic acknowledgment loss");
    });
    expect((await submit()).status).toBe(500);
    expect(await flag()).toEqual({rollout:100,status:"enabled"});
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

  it("admits one audited change when competing requests share a flag snapshot",async () => {
    let release!: () => void;
    const ready = new Promise<void>(resolve => {release=resolve;});
    let arrivals = 0;
    vi.spyOn(db,"batch").mockImplementation(async statements => {
      if (++arrivals === 2) release();
      await ready;
      return base.batch!(statements);
    });
    const responses = await Promise.all([submit(),submit(request(50))]);
    expect(responses.map(response => response.status).sort()).toEqual([200,403]);
    expect(await auditCount()).toEqual({n:1});
    expect(await jobSqlite(file,"readonly-first",`SELECT json_extract(metadata_json,'$.rollout') rollout,
      json_extract(metadata_json,'$.status') status FROM audit_events WHERE action='feature_flag.rollout_updated'`))
      .toEqual(await flag());
  },20000);
});
