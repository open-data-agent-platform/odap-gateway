import { afterEach, describe, expect, it, vi } from "vitest";
import type { D1Database, D1Result } from "../lib/d1";
import { ensureDocsFeedbackSchema, listAdminDocsFeedback, listPublicDocsFeedback, submitDocsFeedback,
  updateDocsFeedbackReview } from "../lib/docs-feedback";
import worker from "../worker";

const baseColumns = ["id", "kind", "topic", "author_name", "author_email", "message", "status", "created_at"];
const answerColumns = ["answer_text", "answered_by", "answered_at"];
const allColumns = [...baseColumns, ...answerColumns];
const submission = {kind:"question" as const,topic:"Docs",authorName:"Reader",authorEmail:"",
  message:"How is a semantic release approved?"};

function schemaFixture(initial = allColumns) {
  const columns = [...initial];
  const create = vi.fn(async (): Promise<D1Result> => ({success:true}));
  const inspect = vi.fn(async (): Promise<D1Result<unknown>> => ({success:true,results:columns.map(name => ({name}))}));
  const alter = vi.fn(async (query: string): Promise<D1Result> => {
    const name = query.split(" ").at(-2)!;
    if (columns.includes(name)) throw new Error("duplicate column name: " + name);
    columns.push(name);
    return {success:true};
  });
  const data = vi.fn(async () => {throw new Error("Unexpected feedback data access");});
  const prepare = vi.fn((query: string) => {
    const statement = {
      bind:() => statement, first:data,
      all:query === "PRAGMA table_info(docs_feedback)" ? inspect : data,
      run:() => /CREATE TABLE IF NOT EXISTS docs_feedback/.test(query) ? create()
        : query.startsWith("ALTER TABLE docs_feedback") ? alter(query) : Promise.resolve({success:true})
    };
    return statement;
  });
  return {db:{prepare,batch:data} as D1Database,create,inspect,alter,data,columns};
}

describe("confirmed feedback schema initialization",() => {
  afterEach(() => {vi.restoreAllMocks();vi.unstubAllGlobals();});

  it("baseline: stops after an unconfirmed table creation",async () => {
    const fixture = schemaFixture();
    fixture.create.mockResolvedValue({success:false});
    await expect(ensureDocsFeedbackSchema(fixture.db)).rejects.toThrow();
    expect(fixture.inspect).not.toHaveBeenCalled();
    expect(fixture.alter).not.toHaveBeenCalled();
  });

  it("baseline: propagates a failed column addition",async () => {
    const fixture = schemaFixture(baseColumns), failure = new Error("Synthetic permission failure");
    fixture.alter.mockRejectedValue(failure);
    await expect(ensureDocsFeedbackSchema(fixture.db)).rejects.toBe(failure);
    expect(fixture.alter).toHaveBeenCalledTimes(1);
  });

  it("baseline: refuses successful DDL without the resulting columns",async () => {
    const fixture = schemaFixture(baseColumns);
    fixture.alter.mockResolvedValue({success:true});
    await expect(ensureDocsFeedbackSchema(fixture.db)).rejects.toThrow();
  });

  it("does not issue duplicate ALTER statements on an already current schema",async () => {
    const fixture = schemaFixture();
    await ensureDocsFeedbackSchema(fixture.db);
    await ensureDocsFeedbackSchema(fixture.db);
    expect(fixture.alter).not.toHaveBeenCalled();
    expect(fixture.inspect).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, "answer_text", "answered_by", "answered_at"])("adds only missing columns: %s",async existing => {
    const fixture = schemaFixture([...baseColumns,...(existing ? [existing] : [])]);
    await ensureDocsFeedbackSchema(fixture.db);
    expect(fixture.alter.mock.calls.map(([query]) => query)).toEqual(answerColumns.filter(name => name !== existing)
      .map(name => `ALTER TABLE docs_feedback ADD COLUMN ${name} TEXT`));
    expect(fixture.inspect).toHaveBeenCalledTimes(2);
    expect(new Set(fixture.columns)).toEqual(new Set(allColumns));
  });

  it.each([{}, {success:false}])("requires an affirmative create acknowledgment: %j",async result => {
    const fixture = schemaFixture();
    fixture.create.mockResolvedValue(result);
    await expect(ensureDocsFeedbackSchema(fixture.db)).rejects.toThrow();
    expect(fixture.inspect).not.toHaveBeenCalled();
  });

  it("does not catch a thrown creation error",async () => {
    const fixture = schemaFixture(), failure = new Error("Synthetic creation failure");
    fixture.create.mockRejectedValue(failure);
    await expect(ensureDocsFeedbackSchema(fixture.db)).rejects.toBe(failure);
    expect(fixture.inspect).not.toHaveBeenCalled();
    expect(fixture.alter).not.toHaveBeenCalled();
  });

  it.each([{}, {success:false,results:[]}, {success:true}, {success:true,results:[]},
    {success:true,results:null}, {success:true,results:[null]}, {success:true,results:[{}]},
    {success:true,results:[{name:9}]}, {success:true,results:[{name:""}]},
    {success:true,results:[...allColumns.map(name => ({name})),{name:"ID"}]}])(
    "rejects malformed or unconfirmed schema metadata: %j",async result => {
      const fixture = schemaFixture();
      fixture.inspect.mockResolvedValue(result as D1Result<unknown>);
      await expect(ensureDocsFeedbackSchema(fixture.db)).rejects.toThrow();
      expect(fixture.alter).not.toHaveBeenCalled();
    });

  it.each(baseColumns)("does not attempt to repair an unexpected missing base column: %s",async missing => {
    const fixture = schemaFixture(allColumns.filter(name => name !== missing));
    await expect(ensureDocsFeedbackSchema(fixture.db)).rejects.toThrow();
    expect(fixture.alter).not.toHaveBeenCalled();
  });

  it("accepts case-insensitive column names and leaves additional columns alone",async () => {
    const fixture = schemaFixture([...allColumns.map(name => name.toUpperCase()),"extension"]);
    await ensureDocsFeedbackSchema(fixture.db);
    expect(fixture.alter).not.toHaveBeenCalled();
  });

  it.each([{}, {success:false}])("stops at a rejected addition without further DDL: %j",async result => {
    const fixture = schemaFixture(baseColumns);
    fixture.alter.mockResolvedValue(result);
    await expect(ensureDocsFeedbackSchema(fixture.db)).rejects.toThrow();
    expect(fixture.alter).toHaveBeenCalledTimes(1);
    expect(fixture.inspect).toHaveBeenCalledTimes(1);
  });

  it.each(["before", "after"])("propagates metadata read failure %s additions",async phase => {
    const fixture = schemaFixture(baseColumns), failure = new Error("Synthetic metadata read failure");
    if (phase === "after") fixture.inspect.mockResolvedValueOnce({success:true,results:baseColumns.map(name => ({name}))});
    fixture.inspect.mockRejectedValue(failure);
    await expect(ensureDocsFeedbackSchema(fixture.db)).rejects.toBe(failure);
    expect(fixture.alter).toHaveBeenCalledTimes(phase === "before" ? 0 : 3);
  });

  it("requires a confirmed post-upgrade metadata response",async () => {
    const fixture = schemaFixture(baseColumns);
    fixture.inspect.mockResolvedValueOnce({success:true,results:baseColumns.map(name => ({name}))})
      .mockResolvedValueOnce({success:false,results:allColumns.map(name => ({name}))});
    await expect(ensureDocsFeedbackSchema(fixture.db)).rejects.toThrow();
  });

  it("does not hide a concurrent duplicate-column failure; a later call can inspect and resume",async () => {
    const fixture = schemaFixture(baseColumns), failure = new Error("duplicate column name: answer_text");
    fixture.alter.mockImplementationOnce(async () => {fixture.columns.push("answer_text");throw failure;});
    await expect(ensureDocsFeedbackSchema(fixture.db)).rejects.toBe(failure);
    await ensureDocsFeedbackSchema(fixture.db);
    expect(fixture.alter.mock.calls.map(([query]) => query)).toEqual(answerColumns
      .map(name => `ALTER TABLE docs_feedback ADD COLUMN ${name} TEXT`));
  });

  it.each(["public read", "admin read", "submission", "review"])("blocks %s on a schema failure without switching bindings",async operation => {
    const fixture = schemaFixture(baseColumns), fallback = schemaFixture();
    fixture.alter.mockRejectedValue(new Error("Synthetic permission failure"));
    const env = {ODAP_GATEWAY_DB:fixture.db,DB:fallback.db};
    const action = operation === "public read" ? listPublicDocsFeedback(env)
      : operation === "admin read" ? listAdminDocsFeedback(env)
      : operation === "submission" ? submitDocsFeedback(env,submission)
      : updateDocsFeedbackReview(env,"fixture",{status:"approved"},
        {provider:"google",providerId:"actor",email:"actor@example.test"});
    await expect(action).rejects.toThrow("Synthetic permission failure");
    expect(fixture.data).not.toHaveBeenCalled();
    expect(fallback.create).not.toHaveBeenCalled();
    expect(fallback.inspect).not.toHaveBeenCalled();
  });

  it.each(["GET", "POST"])("keeps the Worker %s response unsuccessful and hides storage diagnostics",async method => {
    const fixture = schemaFixture(baseColumns);
    fixture.alter.mockRejectedValue(new Error("private-storage-diagnostic"));
    vi.stubGlobal("fetch",vi.fn(async () => {throw new Error("Unexpected remote request");}));
    vi.spyOn(console,"error").mockImplementation(() => {});
    const response = await worker.fetch(new Request("https://gateway.test/api/docs/feedback",{
      method,...(method === "POST" ? {body:JSON.stringify(submission)} : {})
    }),{DB:fixture.db,ASSETS:{fetch:async () => {throw new Error("Unexpected assets request");}}},
    {waitUntil:() => {throw new Error("Unexpected background task");}});
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toMatchObject({ok:false,code:"internal_error"});
    expect(JSON.stringify(body)).not.toContain("private-storage-diagnostic");
    expect(fixture.data).not.toHaveBeenCalled();
  });
});
