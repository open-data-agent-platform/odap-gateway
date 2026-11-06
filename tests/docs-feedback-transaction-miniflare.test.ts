import { Miniflare } from "miniflare";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureAdminSchema } from "../lib/admin-store";
import { ensureDocsFeedbackSchema, listPublicDocsFeedback, updateDocsFeedbackReview } from "../lib/docs-feedback";
import type { D1Database } from "../lib/d1";

let mf: Miniflare, db: D1Database;
const actor = {provider:"google" as const,providerId:"actor",email:"actor@example.test"};
const update = () => updateDocsFeedbackReview({DB:db},"fixture-feedback",
  {status:"approved",answerText:"Revised answer."},actor);
const state = async () => ({
  feedback:await db.prepare("SELECT * FROM docs_feedback WHERE id='fixture-feedback'").first(),
  audits:(await db.prepare("SELECT * FROM audit_events ORDER BY id").all()).results
});
const publicItem = async () => (await listPublicDocsFeedback({DB:db})).feedback.find(item => item.id === "fixture-feedback");

describe("feedback review transaction on installed local D1",() => {
  beforeAll(async () => {
    mf = new Miniflare({host:"127.0.0.1",port:0,modules:true,
      script:"export default {fetch(){return new Response('Local feedback transaction test');}}",
      d1Databases:{DB:"local-feedback-transaction"},d1Persist:false});
    db = await mf.getD1Database("DB") as unknown as D1Database;
    await ensureAdminSchema(db);
    await ensureDocsFeedbackSchema(db);
    await db.prepare(`INSERT INTO users VALUES ('google:actor','google','actor','actor@example.test',
      'Actor',NULL,'admin','fixture','fixture','fixture')`).run();
  },30000);
  beforeEach(async () => {
    await db.prepare("DROP TRIGGER IF EXISTS injected_failure").run();
    await db.prepare("DELETE FROM audit_events").run();
    await db.prepare("UPDATE users SET role='admin' WHERE id='google:actor'").run();
    await db.prepare("DELETE FROM docs_feedback WHERE id='fixture-feedback'").run();
    await db.prepare(`INSERT INTO docs_feedback VALUES ('fixture-feedback','question','Synthetic topic',
      'Synthetic author','author@example.test','Synthetic question text.','pending',
      'Original answer.','previous@example.test','fixture','fixture')`).run();
  });
  afterEach(() => {vi.restoreAllMocks();});
  afterAll(async () => {await mf?.dispose();});

  it("exposes the reviewed answer only after its audited commit",async () => {
    expect(await publicItem()).toBeUndefined();
    expect(await update()).toMatchObject({ok:true,feedback:{status:"approved",answerText:"Revised answer."}});
    expect((await state()).audits).toHaveLength(1);
    expect(await publicItem()).toMatchObject({status:"approved",answerText:"Revised answer."});
    expect(await publicItem()).not.toHaveProperty("authorEmail");
  });

  it.each([
    ["audit","BEFORE INSERT ON audit_events"],
    ["review","BEFORE UPDATE ON docs_feedback WHEN OLD.id='fixture-feedback'"]
  ])("keeps content unpublished when %s aborts",async (_label,clause) => {
    await db.prepare(`CREATE TRIGGER injected_failure ${clause}
      BEGIN SELECT RAISE(ABORT,'synthetic transaction failure'); END`).run();
    const before = await state();
    await expect(update()).rejects.toThrow();
    expect(await state()).toEqual(before);
    expect(await publicItem()).toBeUndefined();
  });

  it.each([
    ["audit","BEFORE INSERT ON audit_events",false],
    ["review","BEFORE UPDATE ON docs_feedback WHEN OLD.id='fixture-feedback'",true]
  ])("keeps content unpublished when %s is skipped",async (_label,clause,aborts) => {
    await db.prepare(`CREATE TRIGGER injected_failure ${clause} BEGIN SELECT RAISE(IGNORE); END`).run();
    const before = await state();
    if (aborts) await expect(update()).rejects.toThrow();
    else expect(await update()).toMatchObject({ok:false,status:403});
    expect(await state()).toEqual(before);
    expect(await publicItem()).toBeUndefined();
  });

  it.each([false,true])("preserves a skipped colliding audit, actor revoked=%s",async revoked => {
    await db.prepare("INSERT INTO audit_events VALUES ('collision','prior@example.test','docs_feedback.reviewed','prior','{}','prior')").run();
    await db.prepare("CREATE TRIGGER injected_failure BEFORE INSERT ON audit_events BEGIN SELECT RAISE(IGNORE); END").run();
    if (revoked) await db.prepare("UPDATE users SET role='member' WHERE id='google:actor'").run();
    vi.spyOn(crypto,"randomUUID").mockReturnValue("collision");
    const before = await state();
    await expect(update()).rejects.toThrow();
    expect(await state()).toEqual(before);
    expect(await publicItem()).toBeUndefined();
  });
});
