import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionCookie, signAuthPayload } from "../lib/auth";
import { ensureAdminSchema } from "../lib/admin-store";
import { ensureDocsFeedbackSchema, updateDocsFeedbackReview } from "../lib/docs-feedback";
import { jobSqlite, jobTransactionalDatabase } from "./fixtures/job-sqlite";
import worker from "../worker";

let dir: string, file: string, baseline: string, cookie: string;
let beforeWrite: (() => Promise<void>) | null = null;
const base = jobTransactionalDatabase(() => file);
const db = {...base,batch: async (statements: Parameters<NonNullable<typeof base.batch>>[0]) => {
  const hook = beforeWrite;
  beforeWrite = null;
  await hook?.();
  return base.batch!(statements);
}};
const actor = {provider:"google" as const,providerId:"actor",email:"actor@example.test"};
const env = {AUTH_COOKIE_SECRET:"synthetic-feedback-review",DB:db,
  ASSETS:{fetch:async () => {throw new Error("Unexpected asset request");}}};
const sql = (query: string) => jobSqlite(file,"run",query);
const row = () => jobSqlite(file,"readonly-first","SELECT * FROM docs_feedback WHERE id='fixture-feedback'");
const auditCount = () => jobSqlite(file,"readonly-first","SELECT count(*) n FROM audit_events WHERE action='docs_feedback.reviewed'");
const request = (body: Record<string,unknown> = {status:"approved",answerText:"Revised answer."}) =>
  new Request("https://gateway.test/api/admin/docs-feedback/fixture-feedback",{
    method:"PATCH",headers:{Cookie:cookie,"Content-Type":"application/json"},body:JSON.stringify(body)
  });
const submit = (input = request()) => worker.fetch(input,env,{waitUntil:() => {throw new Error("Unexpected background task");}});

describe("current authority and atomic feedback review",() => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(),"odap-feedback-review-"));
    file = baseline = join(dir,"baseline.sqlite");
    await ensureAdminSchema(db);
    await ensureDocsFeedbackSchema(db);
    await sql(`INSERT INTO users VALUES ('google:actor','google','actor','actor@example.test',
      'Actor',NULL,'admin','fixture','fixture','fixture')`);
    await sql(`INSERT INTO docs_feedback VALUES ('fixture-feedback','question','Synthetic topic',
      'Synthetic author','author@example.test','Synthetic question text.','pending',
      'Original answer.','previous@example.test','fixture','fixture')`);
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

  it("refuses feedback review after actor demotion during body parsing",async () => {
    const before = await row(), input = request(), parse = input.json.bind(input);
    input.json = async () => {await sql("UPDATE users SET role='member' WHERE id='google:actor'");return parse();};
    const response = await submit(input);
    expect({status:response.status,feedback:await row()}).toEqual({status:403,feedback:before});
    expect(await auditCount()).toEqual({n:0});
  },20000);

  it("retains unpublished content when the required audit fails",async () => {
    await sql(`CREATE TRIGGER failed_feedback_audit BEFORE INSERT ON audit_events
      WHEN NEW.action='docs_feedback.reviewed' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END`);
    const before = await readFile(file);
    expect((await submit()).status).toBe(500);
    expect(await row()).toMatchObject({status:"pending",answer_text:"Original answer."});
    expect(await auditCount()).toEqual({n:0});
    expect(await readFile(file)).toEqual(before);
  },20000);

  it.each([
    ["demotion","UPDATE users SET role='member' WHERE id='google:actor'"],
    ["removal","DELETE FROM users WHERE id='google:actor'"],
    ["subject change","UPDATE users SET provider_id='other' WHERE id='google:actor'"],
    ["provider change","UPDATE users SET provider='github' WHERE id='google:actor'"],
    ["contact change","UPDATE users SET email='other@example.test' WHERE id='google:actor'"]
  ])("refuses actor %s at the write boundary",async (_label,change) => {
    let before: Buffer | undefined;
    beforeWrite = async () => {await sql(change);before = await readFile(file);};
    const response = await submit();
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({code:"docs_feedback_review_denied"});
    expect(beforeWrite).toBeNull();
    expect(await auditCount()).toEqual({n:0});
    expect(await readFile(file)).toEqual(before);
  },20000);

  it.each([
    "kind='comment'","topic='Changed topic'","author_name='Another author'",
    "author_email='changed@example.test'","message='Changed question text.'","status='approved'",
    "answer_text='A competing answer.'","answered_by='another@example.test'",
    "answered_at='changed'","created_at='changed'",null
  ])("preserves an intervening feedback change: %s",async change => {
    let before: Buffer | undefined;
    beforeWrite = async () => {
      await sql(change ? `UPDATE docs_feedback SET ${change} WHERE id='fixture-feedback'`
        : "DELETE FROM docs_feedback WHERE id='fixture-feedback'");
      before = await readFile(file);
    };
    expect((await submit()).status).toBe(403);
    expect(beforeWrite).toBeNull();
    expect(await auditCount()).toEqual({n:0});
    expect(await readFile(file)).toEqual(before);
  },20000);

  it.each(["author_email","answer_text","answered_by","answered_at"])(
    "distinguishes null from empty %s in the inspected record",async column => {
      await sql(`UPDATE docs_feedback SET ${column}=NULL WHERE id='fixture-feedback'`);
      let before: Buffer | undefined;
      beforeWrite = async () => {
        await sql(`UPDATE docs_feedback SET ${column}='' WHERE id='fixture-feedback'`);
        before = await readFile(file);
      };
      expect((await submit()).status).toBe(403);
      expect(beforeWrite).toBeNull();
      expect(await readFile(file)).toEqual(before);
    },20000);

  it("returns the stored normalized answer with one privacy-limited audit",async () => {
    const response = await submit(request({status:"approved",answerText:"  Revised\n answer.  "}));
    expect(response.status).toBe(200);
    const body = await response.json() as {feedback:{answeredAt:string}};
    expect(body).toMatchObject({ok:true,feedback:{id:"fixture-feedback",kind:"question",topic:"Synthetic topic",
      authorName:"Synthetic author",authorEmail:"author@example.test",message:"Synthetic question text.",
      status:"approved",answerText:"Revised answer.",answeredBy:actor.email,createdAt:"fixture"}});
    expect(await row()).toMatchObject({status:"approved",answer_text:"Revised answer.",
      answered_by:actor.email,answered_at:body.feedback.answeredAt});
    expect(await auditCount()).toEqual({n:1});
    expect(await jobSqlite(file,"readonly-first","SELECT actor_email,target,metadata_json,created_at FROM audit_events"))
      .toEqual({actor_email:actor.email,target:"fixture-feedback",created_at:body.feedback.answeredAt,
        metadata_json:JSON.stringify({previousStatus:"pending",previousAnswered:true,status:"approved",
          answered:true,answerChanged:true})});
    expect(fetch).not.toHaveBeenCalled();
  },20000);

  it("preserves answer attribution when only moderation status changes",async () => {
    expect((await submit(request({status:"approved"}))).status).toBe(200);
    expect(await row()).toMatchObject({status:"approved",answer_text:"Original answer.",
      answered_by:"previous@example.test",answered_at:"fixture"});
    expect(await jobSqlite(file,"readonly-first","SELECT json_extract(metadata_json,'$.answerChanged') changed FROM audit_events"))
      .toEqual({changed:0});
    expect(await auditCount()).toEqual({n:1});
  },20000);

  it("clears answer text and attribution together",async () => {
    const response = await submit(request({answerText:"  \n  "}));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({feedback:{status:"pending"}});
    expect(await row()).toMatchObject({status:"pending",answer_text:null,answered_by:null,answered_at:null});
    expect(await jobSqlite(file,"readonly-first","SELECT json_extract(metadata_json,'$.answered') answered FROM audit_events"))
      .toEqual({answered:0});
    expect(await auditCount()).toEqual({n:1});
  },20000);

  it("can answer previously null fields and retains the existing length bound",async () => {
    await sql("UPDATE docs_feedback SET author_email=NULL,answer_text=NULL,answered_by=NULL,answered_at=NULL WHERE id='fixture-feedback'");
    const response = await submit(request({answerText:"x".repeat(1700)}));
    expect(response.status).toBe(200);
    expect(await row()).toMatchObject({author_email:null,answer_text:"x".repeat(1600),answered_by:actor.email});
    expect(await auditCount()).toEqual({n:1});
  },20000);

  it("rejects invalid moderation status before a transaction",async () => {
    const before = await readFile(file), batch = vi.spyOn(db,"batch");
    expect((await submit(request({status:"unknown"}))).status).toBe(400);
    expect(batch).not.toHaveBeenCalled();
    expect(await readFile(file)).toEqual(before);
  },20000);

  it.each([
    ["audit","BEFORE INSERT ON audit_events WHEN NEW.action='docs_feedback.reviewed'",403],
    ["review","BEFORE UPDATE ON docs_feedback WHEN OLD.id='fixture-feedback'",500]
  ])("keeps no change when the %s statement is skipped",async (_label,clause,status) => {
    await sql(`CREATE TRIGGER skipped_review_write ${clause} BEGIN SELECT RAISE(IGNORE); END`);
    const before = await readFile(file);
    expect((await submit()).status).toBe(status);
    expect(await auditCount()).toEqual({n:0});
    expect(await readFile(file)).toEqual(before);
  },20000);

  it("rolls back its audit when the feedback update aborts",async () => {
    await sql(`CREATE TRIGGER failed_review_write BEFORE UPDATE ON docs_feedback
      WHEN OLD.id='fixture-feedback' BEGIN SELECT RAISE(ABORT,'synthetic update failure'); END`);
    const before = await readFile(file);
    expect((await submit()).status).toBe(500);
    expect(await auditCount()).toEqual({n:0});
    expect(await readFile(file)).toEqual(before);
  },20000);

  it.each([false,true])("preserves a colliding historical audit, skipped insert=%s",async skipped => {
    await sql("INSERT INTO audit_events VALUES ('collision','prior@example.test','docs_feedback.reviewed','prior','{}','prior')");
    if (skipped) await sql("CREATE TRIGGER ignored_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(IGNORE); END");
    vi.spyOn(crypto,"randomUUID").mockReturnValue("collision");
    const before = await readFile(file);
    expect((await submit()).status).toBe(500);
    expect(await readFile(file)).toEqual(before);
  },20000);

  it("requires transaction support before initialization without binding fallback",async () => {
    const prepare = vi.fn(), before = await readFile(file);
    expect(await updateDocsFeedbackReview({ODAP_GATEWAY_DB:{prepare},DB:db},"fixture-feedback",{status:"approved"},actor))
      .toMatchObject({ok:false,status:503,code:"docs_feedback_transaction_unavailable"});
    expect(prepare).not.toHaveBeenCalled();
    expect(await readFile(file)).toEqual(before);
  });

  it("returns not found for an absent non-seed review",async () => {
    await sql("DELETE FROM docs_feedback WHERE id='fixture-feedback'");
    const before = await readFile(file), batch = vi.spyOn(db,"batch");
    expect((await submit()).status).toBe(404);
    expect(batch).not.toHaveBeenCalled();
    expect(await readFile(file)).toEqual(before);
  },20000);

  it("does not automatically retry after a committed acknowledgment is lost",async () => {
    const batch = vi.spyOn(db,"batch").mockImplementation(async statements => {
      await base.batch!(statements);
      throw new Error("Synthetic acknowledgment loss");
    });
    expect((await submit()).status).toBe(500);
    expect(await row()).toMatchObject({status:"approved",answer_text:"Revised answer."});
    expect(await auditCount()).toEqual({n:1});
    expect(batch).toHaveBeenCalledTimes(1);
  },20000);

  it("does not fabricate success from an unsuccessful batch result",async () => {
    vi.spyOn(db,"batch").mockResolvedValue([{success:false,results:[]}]);
    const before = await readFile(file);
    expect((await submit()).status).toBe(500);
    expect(await readFile(file)).toEqual(before);
  },20000);

  it("admits one decision when two reviewers inspected the same record",async () => {
    let release!: () => void;
    const ready = new Promise<void>(resolve => {release=resolve;});
    let arrivals = 0;
    vi.spyOn(db,"batch").mockImplementation(async statements => {
      if (++arrivals === 2) release();
      await ready;
      return base.batch!(statements);
    });
    const responses = await Promise.all([submit(),submit(request({status:"pending",answerText:"Other answer."}))]);
    expect(responses.map(response => response.status).sort()).toEqual([200,403]);
    expect(await auditCount()).toEqual({n:1});
    expect(await jobSqlite(file,"readonly-first","SELECT json_extract(metadata_json,'$.status') status FROM audit_events"))
      .toEqual({status:(await row()).status});
  },30000);
});
