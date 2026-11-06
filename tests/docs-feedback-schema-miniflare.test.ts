import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { D1Database } from "../lib/d1";
import { ensureDocsFeedbackSchema, listPublicDocsFeedback, submitDocsFeedback } from "../lib/docs-feedback";

let mf: Miniflare, db: D1Database;
const legacy = `CREATE TABLE docs_feedback (id TEXT PRIMARY KEY, kind TEXT NOT NULL, topic TEXT NOT NULL,
  author_name TEXT NOT NULL, author_email TEXT, message TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL)`;
const rows = async () => (await db.prepare("SELECT * FROM docs_feedback ORDER BY id").all()).results!;
const columns = async () => (await db.prepare("PRAGMA table_info(docs_feedback)").all<{name:string}>()).results!.map(row => row.name);
const add = (name: string) => `ALTER TABLE docs_feedback ADD COLUMN ${name} TEXT`;
const seedExisting = () => db.prepare(`INSERT INTO docs_feedback
  (id,kind,topic,author_name,author_email,message,status,created_at)
  VALUES ('existing','question','Docs','Reader','private@example.test','Existing user question.','approved','fixture')`).run();

function observe(hook: (query: string, phase: "before" | "after") => Promise<void> = async () => {}) {
  const queries: string[] = [];
  const wrapped: D1Database = {prepare(query) {
    queries.push(query);
    const statement = db.prepare(query);
    return {
      bind:(...values) => statement.bind(...values),
      first:<T>(column?: string) => statement.first<T>(column),
      all:<T>() => statement.all<T>(),
      run:async <T>() => {
        await hook(query,"before");
        const result = await statement.run<T>();
        await hook(query,"after");
        return result;
      }
    };
  }};
  return {wrapped,alters:() => queries.filter(query => query.startsWith("ALTER TABLE"))};
}

describe("feedback schema upgrades on installed local D1",() => {
  beforeAll(async () => {
    mf = new Miniflare({host:"127.0.0.1",port:0,modules:true,
      script:"export default {fetch(){return new Response('Local feedback schema test');}}",
      d1Databases:{DB:"local-feedback-schema"},d1Persist:false});
    db = await mf.getD1Database("DB") as unknown as D1Database;
  },30000);
  beforeEach(async () => {await db.prepare("DROP TABLE IF EXISTS docs_feedback").run();});
  afterAll(async () => {await mf?.dispose();});

  it("creates and repeatedly inspects a current empty table without ALTER or example rows",async () => {
    const fixture = observe();
    await ensureDocsFeedbackSchema(fixture.wrapped);
    await ensureDocsFeedbackSchema(fixture.wrapped);
    expect(fixture.alters()).toEqual([]);
    expect(await columns()).toHaveLength(11);
    expect(await rows()).toEqual([]);
  });

  it("adds the three legacy columns without rewriting existing feedback",async () => {
    await db.prepare(legacy).run();
    await seedExisting();
    const before = await rows(), fixture = observe();
    await ensureDocsFeedbackSchema(fixture.wrapped);
    expect(fixture.alters()).toEqual([add("answer_text"),add("answered_by"),add("answered_at")]);
    expect(await rows()).toEqual(before.map(row => ({...row,answer_text:null,answered_by:null,answered_at:null})));
    const visible = await listPublicDocsFeedback({DB:db});
    expect(visible.feedback).toEqual([expect.objectContaining({id:"existing",message:"Existing user question."})]);
    expect(visible.feedback[0]).not.toHaveProperty("authorEmail");
  });

  it("preserves an existing answer and adds only the remaining columns",async () => {
    await db.prepare(legacy).run();
    await db.prepare(add("answer_text")).run();
    await seedExisting();
    await db.prepare("UPDATE docs_feedback SET answer_text='Existing answer.'").run();
    const before = await rows(), fixture = observe();
    await ensureDocsFeedbackSchema(fixture.wrapped);
    expect(fixture.alters()).toEqual([add("answered_by"),add("answered_at")]);
    expect(await rows()).toEqual(before.map(row => ({...row,answered_by:null,answered_at:null})));
  });

  it("stops a submission on partial upgrade failure and resumes only missing columns later",async () => {
    await db.prepare(legacy).run();
    await seedExisting();
    const failure = new Error("Synthetic permission failure");
    const fixture = observe(async (query,phase) => {if (query === add("answered_by") && phase === "before") throw failure;});
    await expect(submitDocsFeedback({DB:fixture.wrapped},{kind:"question",topic:"Docs",authorName:"New reader",
      authorEmail:"",message:"A second question must not be inserted."})).rejects.toBe(failure);
    expect(fixture.alters()).toEqual([add("answer_text"),add("answered_by")]);
    expect(await columns()).toContain("answer_text");
    expect(await columns()).not.toContain("answered_by");
    expect(await rows()).toHaveLength(1);
    const resume = observe();
    await ensureDocsFeedbackSchema(resume.wrapped);
    expect(resume.alters()).toEqual([add("answered_by"),add("answered_at")]);
    expect(await rows()).toEqual([expect.objectContaining({id:"existing",answer_text:null,answered_by:null,answered_at:null})]);
  });

  it("does not report success after a lost DDL acknowledgment and safely inspects on a later call",async () => {
    await db.prepare(legacy).run();
    await seedExisting();
    const failure = new Error("Synthetic lost acknowledgment");
    const fixture = observe(async (query,phase) => {if (query === add("answer_text") && phase === "after") throw failure;});
    await expect(ensureDocsFeedbackSchema(fixture.wrapped)).rejects.toBe(failure);
    expect(fixture.alters()).toEqual([add("answer_text")]);
    const resume = observe();
    await ensureDocsFeedbackSchema(resume.wrapped);
    expect(resume.alters()).toEqual([add("answered_by"),add("answered_at")]);
    expect(await rows()).toHaveLength(1);
  });

  it("allows concurrent initialization of a fresh current schema",async () => {
    const fixture = observe();
    await Promise.all(Array.from({length:6},() => ensureDocsFeedbackSchema(fixture.wrapped)));
    expect(fixture.alters()).toEqual([]);
    expect(await columns()).toHaveLength(11);
    expect(await rows()).toEqual([]);
  });

  it("fails the stale legacy upgrader visibly while retaining a concurrent successful upgrade",async () => {
    await db.prepare(legacy).run();
    await seedExisting();
    let competed = false;
    const fixture = observe(async (query,phase) => {
      if (!competed && query === add("answer_text") && phase === "before") {
        competed = true;
        await ensureDocsFeedbackSchema(db);
      }
    });
    await expect(ensureDocsFeedbackSchema(fixture.wrapped)).rejects.toThrow(/duplicate column/i);
    expect(competed).toBe(true);
    expect(fixture.alters()).toEqual([add("answer_text")]);
    await ensureDocsFeedbackSchema(db);
    expect(await columns()).toHaveLength(11);
    expect(await rows()).toHaveLength(1);
  });

  it("does not repair or write to an incompatible base table",async () => {
    await db.prepare("CREATE TABLE docs_feedback (id TEXT PRIMARY KEY, message TEXT)").run();
    await db.prepare("INSERT INTO docs_feedback VALUES ('existing','Retain this row.')").run();
    const before = await rows(), fixture = observe();
    await expect(ensureDocsFeedbackSchema(fixture.wrapped)).rejects.toThrow("Feedback base schema not confirmed");
    expect(fixture.alters()).toEqual([]);
    expect(await rows()).toEqual(before);
  });
});
