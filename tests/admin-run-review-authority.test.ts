import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionCookie, signAuthPayload } from "../lib/auth";
import { ensureAdminSchema, updateRunReviewStatus } from "../lib/admin-store";
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
const actor = {provider:"google" as const,providerId:"actor",email:"actor@example.test"};
const env = {AUTH_COOKIE_SECRET:"synthetic-run-review",DB:db,
  ASSETS:{fetch:async () => {throw new Error("Unexpected asset request");}}};
const sql = (query: string) => jobSqlite(file,"run",query);
const state = async () => ({
  review:await jobSqlite(file,"readonly-first","SELECT status FROM run_reviews WHERE id='fixture-run'"),
  run:await jobSqlite(file,"readonly-first","SELECT status FROM query_runs WHERE id='fixture-run'"),
  audit:await jobSqlite(file,"readonly-first","SELECT count(*) n FROM audit_events WHERE action IN ('query.approved','query.blocked')")
});
const original = {review:{status:"needs_approval"},run:{status:"needs_approval"},audit:{n:0}};
const request = (status: unknown = "approved") => new Request("https://gateway.test/api/admin/run-reviews/fixture-run",{
  method:"PATCH",headers:{Cookie:cookie,"Content-Type":"application/json"},body:JSON.stringify({status})
});
const submit = (input = request()) => worker.fetch(input,env,{waitUntil:() => {throw new Error("Unexpected background task");}});

describe("current authority and atomic legacy run review",() => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(),"odap-run-review-"));
    file = baseline = join(dir,"baseline.sqlite");
    await ensureAdminSchema(db);
    await sql(`INSERT INTO users(id,provider,provider_id,email,name,role,last_login_at,created_at,updated_at)
      VALUES ('google:actor','google','actor','actor@example.test','Actor','admin','fixture','fixture','fixture')`);
    await sql(`INSERT INTO run_reviews VALUES ('fixture-run','fixture-workspace','Synthetic preview',
      'needs_approval',0.1,100,'fixture')`);
    await sql(`INSERT INTO query_runs VALUES ('fixture-run','fixture-workspace',NULL,'SELECT 1',
      'needs_approval','simulated',0.1,100,10,'[]','[]',NULL,'fixture','fixture')`);
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

  it("refuses review after actor demotion during body parsing",async () => {
    const input = request(), parse = input.json.bind(input);
    input.json = async () => {await sql("UPDATE users SET role='member' WHERE id='google:actor'");return parse();};
    const response = await submit(input);
    expect({status:response.status,...await state()}).toEqual({status:403,...original});
  },20000);

  it("retains both original statuses when audit persistence fails",async () => {
    await sql(`CREATE TRIGGER fail_review_audit BEFORE INSERT ON audit_events
      WHEN NEW.action='query.approved' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END`);
    const before = await readFile(file);
    expect((await submit()).status).toBe(500);
    expect(await state()).toEqual(original);
    expect(await readFile(file)).toEqual(before);
  },20000);

  it.each([
    ["demoted actor","UPDATE users SET role='member' WHERE id='google:actor'"],
    ["removed actor","DELETE FROM users WHERE id='google:actor'"],
    ["rebound subject","UPDATE users SET provider_id='replacement' WHERE id='google:actor'"],
    ["rebound provider","UPDATE users SET provider='github' WHERE id='google:actor'"],
    ["changed audit contact","UPDATE users SET email='changed@example.test' WHERE id='google:actor'"]
  ])("refuses %s at the transaction boundary",async (_label,change) => {
    let before: Buffer | undefined;
    beforeWrite = async () => {await sql(change);before = await readFile(file);};
    const response = await submit();
    expect(beforeWrite).toBeNull();
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({code:"run_review_update_denied"});
    expect(await state()).toEqual(original);
    expect(await readFile(file)).toEqual(before);
  },20000);

  it.each([
    ["run_reviews","workspace='other-workspace'"],
    ["run_reviews","query_type='Changed preview'"],
    ["run_reviews","status='blocked'"],
    ["run_reviews","estimated_cost_usd=9"],
    ["run_reviews","scanned_bytes=999"],
    ["run_reviews","submitted_at='changed'"],
    ["run_reviews",null],
    ["query_runs","workspace='other-workspace'"],
    ["query_runs","actor_email='other@example.test'"],
    ["query_runs","sql='SELECT 2'"],
    ["query_runs","status='blocked'"],
    ["query_runs","mode='live'"],
    ["query_runs","estimated_cost_usd=9"],
    ["query_runs","scanned_bytes=999"],
    ["query_runs","expected_runtime_ms=99"],
    ["query_runs","referenced_tables_json='[\"other.table\"]'"],
    ["query_runs","checks_json='[{\"status\":\"blocked\"}]'"],
    ["query_runs","error_json='{\"code\":\"changed\"}'"],
    ["query_runs","created_at='changed'"],
    ["query_runs","updated_at='changed'"],
    ["query_runs",null]
  ])("preserves an intervening %s change: %s",async (table,change) => {
    let before: Buffer | undefined;
    beforeWrite = async () => {
      await sql(change ? `UPDATE ${table} SET ${change} WHERE id='fixture-run'`
        : `DELETE FROM ${table} WHERE id='fixture-run'`);
      before = await readFile(file);
    };
    expect((await submit()).status).toBe(403);
    expect(beforeWrite).toBeNull();
    expect(await readFile(file)).toEqual(before);
  },20000);

  it.each(["workspace='other'","status='blocked'","estimated_cost_usd=9","scanned_bytes=999",null])(
    "refuses an already inconsistent query record: %s",async change => {
      await sql(change ? `UPDATE query_runs SET ${change} WHERE id='fixture-run'`
        : "DELETE FROM query_runs WHERE id='fixture-run'");
      const before = await readFile(file), batch = vi.spyOn(db,"batch");
      const response = await submit();
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({code:"run_review_inconsistent"});
      expect(batch).not.toHaveBeenCalled();
      expect(await readFile(file)).toEqual(before);
    },20000);

  it.each(["approved","blocked"] as const)("commits actual %s records and matching audit",async status => {
    const response = await submit(request(status));
    expect(response.status).toBe(200);
    const body = await response.json() as {review:{submittedAt:string}};
    expect(body).toMatchObject({ok:true,review:{id:"fixture-run",workspace:"fixture-workspace",
      queryType:"Synthetic preview",status,estimatedCostUsd:0.1,scannedBytes:100}});
    expect(await state()).toEqual({review:{status},run:{status},audit:{n:1}});
    expect(await jobSqlite(file,"readonly-first","SELECT updated_at FROM query_runs WHERE id='fixture-run'"))
      .toEqual({updated_at:body.review.submittedAt});
    expect(await jobSqlite(file,"readonly-first","SELECT actor_email,action,target,metadata_json,created_at FROM audit_events"))
      .toEqual({actor_email:actor.email,action:`query.${status}`,target:"fixture-run",created_at:body.review.submittedAt,
        metadata_json:JSON.stringify({workspace:"fixture-workspace",queryType:"Synthetic preview",
          previousStatus:"needs_approval",status,mode:"simulated",estimatedCostUsd:0.1,scannedBytes:100})});
    expect(fetch).not.toHaveBeenCalled();
  },20000);

  it.each([
    ["audit insert","BEFORE INSERT ON audit_events",403],
    ["query update","BEFORE UPDATE OF status ON query_runs",500],
    ["review update","BEFORE UPDATE OF status ON run_reviews",500]
  ])("keeps all original records when %s is ignored",async (_label,clause,status) => {
    await sql(`CREATE TRIGGER ignored_review_write ${clause} BEGIN SELECT RAISE(IGNORE); END`);
    const before = await readFile(file);
    expect((await submit()).status).toBe(status);
    expect(await state()).toEqual(original);
    expect(await readFile(file)).toEqual(before);
  },20000);

  it.each(["query_runs","run_reviews"])("rolls back every write when %s aborts",async table => {
    await sql(`CREATE TRIGGER failed_review_write BEFORE UPDATE OF status ON ${table}
      BEGIN SELECT RAISE(ABORT,'synthetic status failure'); END`);
    const before = await readFile(file);
    expect((await submit()).status).toBe(500);
    expect(await state()).toEqual(original);
    expect(await readFile(file)).toEqual(before);
  },20000);

  it.each([false,true])("preserves historical evidence on audit collision, ignored=%s",async ignored => {
    await sql("INSERT INTO audit_events VALUES ('collision','prior@example.test','query.approved','prior','{}','prior')");
    if (ignored) await sql("CREATE TRIGGER ignored_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(IGNORE); END");
    const before = await readFile(file);
    vi.spyOn(crypto,"randomUUID").mockReturnValue("collision");
    expect((await submit()).status).toBe(500);
    expect(await state()).toEqual({...original,audit:{n:1}});
    expect(await readFile(file)).toEqual(before);
  },20000);

  it("requires transactional storage without schema writes or binding fallback",async () => {
    const prepare = vi.fn(), before = await readFile(file);
    expect(await updateRunReviewStatus({ODAP_GATEWAY_DB:{prepare},DB:db},"fixture-run","approved",actor))
      .toMatchObject({ok:false,status:503,code:"run_review_transaction_unavailable"});
    expect(prepare).not.toHaveBeenCalled();
    expect(await readFile(file)).toEqual(before);
  });

  it("does not retry after a committed acknowledgment is lost",async () => {
    const batch = vi.spyOn(db,"batch").mockImplementation(async statements => {
      await base.batch!(statements);
      throw new Error("Synthetic acknowledgment loss");
    });
    expect((await submit()).status).toBe(500);
    expect(await state()).toEqual({review:{status:"approved"},run:{status:"approved"},audit:{n:1}});
    expect(batch).toHaveBeenCalledTimes(1);
  },20000);

  it("does not invent a successful response for an unsuccessful batch",async () => {
    vi.spyOn(db,"batch").mockResolvedValue([{success:false,results:[]}]);
    const before = await readFile(file);
    expect((await submit()).status).toBe(500);
    expect(await readFile(file)).toEqual(before);
  },20000);

  it("admits only one decision when concurrent reviewers share a snapshot",async () => {
    let release!: () => void;
    const ready = new Promise<void>(resolve => {release=resolve;});
    let arrivals = 0;
    vi.spyOn(db,"batch").mockImplementation(async statements => {
      if (++arrivals === 2) release();
      await ready;
      return base.batch!(statements);
    });
    const responses = await Promise.all([submit(),submit(request("blocked"))]);
    expect(responses.map(response => response.status).sort()).toEqual([200,403]);
    const current = await state();
    expect(current.audit).toEqual({n:1});
    expect(current.review).toEqual(current.run);
    expect(await jobSqlite(file,"readonly-first","SELECT json_extract(metadata_json,'$.status') status FROM audit_events"))
      .toEqual(current.review);
  },30000);
});
