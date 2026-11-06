import { Miniflare } from "miniflare";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { D1Database } from "../lib/d1";
import { ensureAdminSchema, recordQueryDryRun } from "../lib/admin-store";
import { estimateDryRun } from "../lib/phase2";

let mf: Miniflare, db: D1Database;
const uuid = "12345678-1234-4234-8234-123456789abc";
const id = "run-20261106000000-12345678";
const input = {workspace:"fixture",queryType:"Local preview",actorEmail:"actor@example.test",
  sql:"SELECT 1",preview:estimateDryRun("SELECT 1")};
const record = () => recordQueryDryRun({DB:db},input);
const state = async () => (await db.batch!(["query_runs","run_reviews","audit_events"].map(table =>
  db.prepare(`SELECT * FROM ${table} ORDER BY id`)))).map(result => result.results);

describe("dry-run history transaction on installed local D1",() => {
  beforeAll(async () => {
    mf = new Miniflare({host:"127.0.0.1",port:0,modules:true,
      script:"export default {fetch(){return new Response('Local dry-run history test');}}",
      d1Databases:{DB:"local-dry-run-persistence"},d1Persist:false});
    db = await mf.getD1Database("DB") as unknown as D1Database;
    await ensureAdminSchema(db);
  },30000);
  beforeEach(async () => {
    await db.prepare("DROP TRIGGER IF EXISTS failed_write").run();
    for (const table of ["query_runs","run_reviews","audit_events"]) await db.prepare(`DELETE FROM ${table}`).run();
    vi.useFakeTimers({toFake:["Date"]});
    vi.setSystemTime(new Date("2026-11-06T00:00:00.000Z"));
    vi.spyOn(crypto,"randomUUID").mockReturnValue(uuid);
  });
  afterEach(() => {vi.restoreAllMocks();vi.useRealTimers();});
  afterAll(async () => {await mf?.dispose();});

  it("commits matching query, review and audit together",async () => {
    expect(await record()).toEqual({id,persisted:true,storageBinding:"DB"});
    const [queries,reviews,audits] = await state();
    expect(queries).toMatchObject([{id,workspace:"fixture",actor_email:"actor@example.test",sql:"SELECT 1",status:input.preview.status}]);
    expect(reviews).toMatchObject([{id,query_type:"Local preview",status:input.preview.status}]);
    expect(audits).toMatchObject([{id:uuid,actor_email:"actor@example.test",action:"query.dry_run",target:id}]);
    expect(JSON.parse(audits![0].metadata_json as string)).toEqual({workspace:"fixture",queryType:"Local preview",
      status:input.preview.status,mode:input.preview.mode ?? "simulated",scannedBytes:input.preview.scannedBytes,
      estimatedCostUsd:input.preview.estimatedCostUsd});
  });

  it.each([
    ["query_runs","ABORT"],["run_reviews","ABORT"],["audit_events","ABORT"],
    ["query_runs","IGNORE"],["run_reviews","IGNORE"],["audit_events","IGNORE"]
  ])("rolls back when %s insertion uses %s",async (table,mode) => {
    await db.prepare(`CREATE TRIGGER failed_write BEFORE INSERT ON ${table}
      BEGIN SELECT RAISE(${mode}${mode === "ABORT" ? ",'synthetic failure'" : ""}); END`).run();
    const before = await state();
    await expect(record()).rejects.toThrow();
    expect(await state()).toEqual(before);
  });

  it("does not replace an old review with a colliding generated ID",async () => {
    await db.prepare("INSERT INTO run_reviews VALUES (?,'prior','Prior preview','approved',5,500,'prior')").bind(id).run();
    const before = await state();
    await expect(record()).rejects.toThrow();
    expect(await state()).toEqual(before);
  });

  it.each([false,true])("preserves a colliding audit when ignored=%s",async ignored => {
    await db.prepare("INSERT INTO audit_events VALUES (?,'prior@example.test','prior.action','prior','{}','prior')").bind(uuid).run();
    if (ignored) await db.prepare("CREATE TRIGGER failed_write BEFORE INSERT ON audit_events BEGIN SELECT RAISE(IGNORE); END").run();
    const before = await state();
    await expect(record()).rejects.toThrow();
    expect(await state()).toEqual(before);
  });

  it("does not retry or delete committed history after a lost acknowledgment",async () => {
    const batch = vi.fn(async (statements: Parameters<NonNullable<D1Database["batch"]>>[0]) => {
      await db.batch!(statements);
      throw new Error("Synthetic lost acknowledgment");
    });
    await expect(recordQueryDryRun({DB:{prepare:query => db.prepare(query),batch}},input)).rejects.toThrow("Synthetic lost acknowledgment");
    expect(batch).toHaveBeenCalledTimes(1);
    const [queries,reviews,audits] = await state();
    expect(queries).toHaveLength(1);
    expect(reviews).toHaveLength(1);
    expect(audits).toMatchObject([{target:id}]);
  });
});
