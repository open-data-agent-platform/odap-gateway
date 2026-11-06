import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ensureDocsFeedbackSchema, listAdminDocsFeedback, listPublicDocsFeedback, submitDocsFeedback } from "../lib/docs-feedback";
import type { D1Database } from "../lib/d1";

let mf: Miniflare, db: D1Database;
const submission = {kind:"question" as const,topic:"  Docs  ",authorName:"Reader",authorEmail:"reader@example.test",
  message:"How is a semantic release approved?"};
const rows = async () => (await db.prepare("SELECT * FROM docs_feedback ORDER BY id").all()).results;
const insert = (id: string, status: string) => db.prepare(`INSERT INTO docs_feedback VALUES
  (?,'question','Existing topic','Existing reader','private@example.test','Existing question text.',
   ?,'Existing answer.','reviewer@example.test','fixture','fixture')`).bind(id,status).run();

describe("feedback storage isolation on installed local D1",() => {
  beforeAll(async () => {
    mf = new Miniflare({host:"127.0.0.1",port:0,modules:true,
      script:"export default {fetch(){return new Response('Local feedback storage test');}}",
      d1Databases:{DB:"local-feedback-storage"},d1Persist:false});
    db = await mf.getD1Database("DB") as unknown as D1Database;
    await ensureDocsFeedbackSchema(db);
  },30000);
  beforeEach(async () => {
    await db.prepare("DROP TRIGGER IF EXISTS injected_failure").run();
    await db.prepare("DELETE FROM docs_feedback").run();
  });
  afterAll(async () => {await mf?.dispose();});

  it("keeps initialized storage and both empty views free of examples",async () => {
    await ensureDocsFeedbackSchema(db);
    expect(await listPublicDocsFeedback({DB:db})).toEqual({feedback:[],persisted:true,storageBinding:"DB"});
    expect(await listAdminDocsFeedback({DB:db})).toEqual({feedback:[],persisted:true,storageBinding:"DB"});
    expect(await rows()).toEqual([]);
  });

  it("does not substitute examples when every stored item is pending",async () => {
    await insert("pending","pending");
    const before = await rows();
    expect((await listPublicDocsFeedback({DB:db})).feedback).toEqual([]);
    expect((await listAdminDocsFeedback({DB:db})).feedback).toHaveLength(1);
    expect(await rows()).toEqual(before);
  });

  it("acknowledges exactly the inserted pending submission",async () => {
    const result = await submitDocsFeedback({ODAP_GATEWAY_DB:db},submission);
    expect(result).toMatchObject({ok:true,persisted:true,storageBinding:"ODAP_GATEWAY_DB",
      feedback:{status:"pending",topic:"Docs",message:submission.message}});
    if (!result.ok) throw new Error("Expected stored submission");
    expect(result.feedback).not.toHaveProperty("authorEmail");
    expect(await rows()).toEqual([expect.objectContaining({id:result.feedback.id,status:"pending",
      author_email:submission.authorEmail,answer_text:null,answered_by:null,answered_at:null})]);
    await ensureDocsFeedbackSchema(db);
    expect((await listPublicDocsFeedback({DB:db})).feedback).toEqual([]);
    expect((await listAdminDocsFeedback({DB:db})).feedback).toEqual([
      expect.objectContaining({id:result.feedback.id,authorEmail:submission.authorEmail})
    ]);
  });

  it.each(["IGNORE","ABORT, 'synthetic insert failure'"])("does not acknowledge a skipped or failed insertion: %s",async failure => {
    await db.prepare(`CREATE TRIGGER injected_failure BEFORE INSERT ON docs_feedback
      BEGIN SELECT RAISE(${failure}); END`).run();
    await expect(submitDocsFeedback({DB:db},submission)).rejects.toThrow();
    expect(await rows()).toEqual([]);
    expect((await listPublicDocsFeedback({DB:db})).feedback).toEqual([]);
  });

  it("preserves an existing seed-named record without auto-cleaning or recreating it",async () => {
    await insert("seed-docs-question-1","approved");
    const before = await rows();
    await ensureDocsFeedbackSchema(db);
    const visible = (await listPublicDocsFeedback({DB:db})).feedback;
    expect(visible).toEqual([expect.objectContaining({id:"seed-docs-question-1",message:"Existing question text."})]);
    expect(visible[0]).not.toHaveProperty("authorEmail");
    expect(await rows()).toEqual(before);
    await db.prepare("DELETE FROM docs_feedback WHERE id='seed-docs-question-1'").run();
    await ensureDocsFeedbackSchema(db);
    expect((await listPublicDocsFeedback({DB:db})).feedback).toEqual([]);
    expect(await rows()).toEqual([]);
  });

  it("keeps a seed-named record unpublished after it is returned to pending",async () => {
    await insert("seed-docs-question-1","pending");
    const before = await rows();
    expect((await listPublicDocsFeedback({DB:db})).feedback).toEqual([]);
    expect(await rows()).toEqual(before);
  });

  it("returns stored approved rows only and never includes author contacts",async () => {
    await insert("approved","approved");
    await insert("pending","pending");
    const before = await rows(), result = await listPublicDocsFeedback({DB:db});
    expect(result.feedback).toEqual([expect.objectContaining({id:"approved",answerText:"Existing answer."})]);
    expect(JSON.stringify(result)).not.toContain("private@example.test");
    expect(await rows()).toEqual(before);
  });
});
