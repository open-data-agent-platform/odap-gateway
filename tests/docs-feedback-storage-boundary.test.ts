import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { onRequestGet, onRequestPost } from "../functions/api/docs/feedback";
import { ensureDocsFeedbackSchema, listAdminDocsFeedback, listPublicDocsFeedback, submitDocsFeedback } from "../lib/docs-feedback";
import type { D1Database, D1Result } from "../lib/d1";
import { jobSqlite, jobTransactionalDatabase } from "./fixtures/job-sqlite";
import worker from "../worker";

const directories: string[] = [];
const submission = {kind:"question" as const,topic:"Docs",authorName:"Reader",authorEmail:"",
  message:"How is a semantic release approved?"};

function emptyDatabase(result: D1Result = {success:true,results:[]}) {
  const run = vi.fn(async () => ({success:true}));
  const all = vi.fn(async () => result);
  const first = vi.fn();
  const prepare = vi.fn((query: string) => {
    if (!query.trim()) throw new Error("Empty fixture statement");
    const inspect = async () => ({success:true,results:["id","kind","topic","author_name","author_email","message",
      "status","created_at","answer_text","answered_by","answered_at"].map(name => ({name}))});
    const statement = {bind:() => statement,run,all:query === "PRAGMA table_info(docs_feedback)" ? inspect : all,first};
    return statement;
  });
  return {db:{prepare} as D1Database,prepare,run,all,first};
}

describe("feedback storage boundary",() => {
  afterAll(async () => {for (const dir of directories) await rm(dir,{recursive:true,force:true});});

  it("initializes storage without creating approved demonstration content",async () => {
    const dir = await mkdtemp(join(tmpdir(),"odap-feedback-boundary-"));
    directories.push(dir);
    const file = join(dir,"empty.sqlite"), db = jobTransactionalDatabase(() => file);
    await ensureDocsFeedbackSchema(db);
    expect(await jobSqlite(file,"readonly-first","SELECT count(*) n FROM docs_feedback")).toEqual({n:0});
  },20000);

  it("returns a genuinely empty persisted public result without example fallback",async () => {
    const {db} = emptyDatabase();
    expect(await listPublicDocsFeedback({DB:db})).toEqual({feedback:[],persisted:true,storageBinding:"DB"});
  });

  it("returns no public examples without configured storage",async () => {
    const response = await onRequestGet({request:new Request("https://gateway.test/api/docs/feedback"),env:{}});
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ok:true,feedback:[],persisted:false,storageBinding:null});
  });

  it("does not accept a real submission without storage",async () => {
    const response = await onRequestPost({request:new Request("https://gateway.test/api/docs/feedback",{
      method:"POST",body:JSON.stringify(submission)
    }),env:{}});
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ok:false,code:"docs_feedback_storage_unavailable"});
  });

  it("keeps installation and repeated initialization free of feedback seeds",async () => {
    const dir = await mkdtemp(join(tmpdir(),"odap-feedback-install-"));
    directories.push(dir);
    const file = join(dir,"installed.sqlite"), db = jobTransactionalDatabase(() => file);
    await jobSqlite(file,"apply-legacy-schema");
    await ensureDocsFeedbackSchema(db);
    await ensureDocsFeedbackSchema(db);
    expect(await jobSqlite(file,"readonly-first","SELECT count(*) n FROM docs_feedback")).toEqual({n:0});
  },20000);

  it("returns no admin examples without configured storage",async () => {
    expect(await listAdminDocsFeedback({})).toEqual({feedback:[],persisted:false,storageBinding:null});
  });

  it.each([listPublicDocsFeedback,listAdminDocsFeedback])("does not insert feedback while reading",async read => {
    const {db,prepare} = emptyDatabase();
    expect((await read({DB:db})).feedback).toEqual([]);
    expect(prepare.mock.calls.some(([query]) => /INSERT|UPDATE|DELETE/i.test(query))).toBe(false);
  });

  it.each([
    {success:false,results:[]}, {success:true}, {results:[]},
    {success:true,results:null} as unknown as D1Result
  ])("refuses unconfirmed reads instead of an empty success: %j",async result => {
    const {db} = emptyDatabase(result);
    await expect(listPublicDocsFeedback({DB:db})).rejects.toThrow("Feedback read not confirmed");
    await expect(listAdminDocsFeedback({DB:db})).rejects.toThrow("Feedback read not confirmed");
  });

  it("does not fall back to a secondary binding when the preferred read fails",async () => {
    const preferred = emptyDatabase(), fallback = emptyDatabase();
    preferred.all.mockRejectedValue(new Error("Synthetic read failure"));
    await expect(listPublicDocsFeedback({ODAP_GATEWAY_DB:preferred.db,DB:fallback.db})).rejects.toThrow();
    expect(fallback.prepare).not.toHaveBeenCalled();
  });

  it.each([null,{id:"wrong-id"}])("refuses an unconfirmed submitted identity: %j",async returned => {
    const preferred = emptyDatabase(), fallback = emptyDatabase();
    preferred.first.mockResolvedValue(returned);
    await expect(submitDocsFeedback({ODAP_GATEWAY_DB:preferred.db,DB:fallback.db},submission))
      .rejects.toThrow("Feedback submission not confirmed");
    expect(preferred.first).toHaveBeenCalledTimes(1);
    expect(fallback.prepare).not.toHaveBeenCalled();
  });

  it("keeps the Worker response unsuccessful when a configured read fails",async () => {
    const {db,all} = emptyDatabase();
    all.mockRejectedValue(new Error("Synthetic read failure"));
    const log = vi.spyOn(console,"error").mockImplementation(() => {});
    try {
      const response = await worker.fetch(new Request("https://gateway.test/api/docs/feedback"),{
        DB:db,ASSETS:{fetch:async () => {throw new Error("Unexpected asset request");}}
      },{waitUntil:() => {throw new Error("Unexpected background task");}});
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({ok:false,code:"internal_error"});
    } finally {log.mockRestore();}
  });
});
