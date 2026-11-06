import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { recordQueryDryRun } from "../lib/admin-store";
import { estimateDryRun } from "../lib/phase2";
import { jobSqlite, jobTransactionalDatabase } from "./fixtures/job-sqlite";

let dir: string, file: string, baseline: string;
const base = jobTransactionalDatabase(() => file);
const db = {...base,batch:base.batch!};
const uuid = "12345678-1234-4234-8234-123456789abc";
const runId = "run-20261106000000-12345678";
const sql = (query: string) => jobSqlite(file,"run",query);
const input = {workspace:" Fixture ",queryType:" Local preview ",actorEmail:"ACTOR@example.test",
  sql:"SELECT 1",preview:estimateDryRun("SELECT 1")};
const record = () => recordQueryDryRun({DB:db},input);
const state = async () => ({
  query:await jobSqlite(file,"readonly-first","SELECT * FROM query_runs"),
  review:await jobSqlite(file,"readonly-first","SELECT * FROM run_reviews"),
  audit:await jobSqlite(file,"readonly-first","SELECT * FROM audit_events")
});

describe("atomic dry-run history",() => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(),"odap-dry-run-persistence-"));
    file = baseline = join(dir,"baseline.sqlite");
    await jobSqlite(file,"apply-legacy-schema");
  });
  beforeEach(async () => {
    file = join(dir,"case.sqlite");
    await copyFile(baseline,file);
    vi.useFakeTimers({toFake:["Date"]});
    vi.setSystemTime(new Date("2026-11-06T00:00:00.000Z"));
    vi.spyOn(crypto,"randomUUID").mockReturnValue(uuid);
    vi.stubGlobal("fetch",vi.fn(async () => {throw new Error("Unexpected network call");}));
  });
  afterEach(() => {vi.restoreAllMocks();vi.unstubAllGlobals();vi.useRealTimers();});
  afterAll(async () => {if (dir) await rm(dir,{recursive:true,force:true});});

  it("baseline: refuses a nontransactional primary binding before schema writes",async () => {
    const prepare = vi.fn(db.prepare), before = await readFile(file);
    await expect(recordQueryDryRun({ODAP_GATEWAY_DB:{prepare},DB:db},input)).rejects.toThrow("Transactional storage");
    expect(prepare).not.toHaveBeenCalled();
    expect(await readFile(file)).toEqual(before);
  });

  it("baseline: leaves no partial history when audit insertion aborts",async () => {
    await sql("CREATE TRIGGER failed_write BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
    const before = await readFile(file);
    await expect(record()).rejects.toThrow();
    expect(await readFile(file)).toEqual(before);
  });

  it("baseline: refuses a colliding review ID instead of replacing historical approval",async () => {
    await sql(`INSERT INTO run_reviews VALUES ('${runId}','prior','Prior preview','approved',5,500,'prior')`);
    const before = await readFile(file);
    await expect(record()).rejects.toThrow();
    expect(await readFile(file)).toEqual(before);
  });

  it("commits query, review and required audit with the same inputs and timestamp",async () => {
    expect(await record()).toEqual({id:runId,persisted:true,storageBinding:"DB"});
    const stored = await state();
    expect(stored.query).toMatchObject({id:runId,workspace:"fixture",actor_email:"actor@example.test",
      sql:input.sql,status:input.preview.status,mode:input.preview.mode ?? "simulated",
      referenced_tables_json:JSON.stringify(input.preview.referencedTables),checks_json:JSON.stringify(input.preview.checks),
      created_at:"2026-11-06T00:00:00.000Z",updated_at:"2026-11-06T00:00:00.000Z"});
    expect(stored.review).toEqual({id:runId,workspace:"fixture",query_type:"Local preview",status:input.preview.status,
      estimated_cost_usd:input.preview.estimatedCostUsd,scanned_bytes:input.preview.scannedBytes,submitted_at:stored.query.created_at});
    expect(stored.audit).toEqual({id:uuid,actor_email:"actor@example.test",action:"query.dry_run",target:runId,
      metadata_json:JSON.stringify({workspace:"fixture",queryType:"Local preview",status:input.preview.status,
        mode:input.preview.mode ?? "simulated",scannedBytes:input.preview.scannedBytes,estimatedCostUsd:input.preview.estimatedCostUsd}),
      created_at:stored.query.created_at});
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps a blocked preview as history, not an approval or execution",async () => {
    const preview = {...input.preview,status:"blocked" as const,error:{code:"local_denial",message:"Synthetic denial"}};
    await recordQueryDryRun({DB:db},{...input,actorEmail:undefined,queryType:" ",preview});
    const stored = await state();
    expect(stored.query).toMatchObject({status:"blocked",actor_email:null,error_json:JSON.stringify(preview.error)});
    expect(stored.review).toMatchObject({status:"blocked",query_type:"SQL dry run"});
    expect(stored.audit.actor_email).toBe("anonymous@odap.local");
  });

  it.each(["query_runs","run_reviews","audit_events"])("rolls back when %s silently ignores insertion",async table => {
    await sql(`CREATE TRIGGER failed_write BEFORE INSERT ON ${table} BEGIN SELECT RAISE(IGNORE); END`);
    const before = await readFile(file);
    await expect(record()).rejects.toThrow();
    expect(await readFile(file)).toEqual(before);
  });

  it.each(["query_runs","run_reviews"])("rolls back when %s aborts insertion",async table => {
    await sql(`CREATE TRIGGER failed_write BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'synthetic failure'); END`);
    const before = await readFile(file);
    await expect(record()).rejects.toThrow();
    expect(await readFile(file)).toEqual(before);
  });

  it.each([false,true])("preserves an audit ID collision, ignored=%s",async ignored => {
    await sql(`INSERT INTO audit_events VALUES ('${uuid}','prior@example.test','prior.action','prior','{}','prior')`);
    if (ignored) await sql("CREATE TRIGGER failed_write BEFORE INSERT ON audit_events BEGIN SELECT RAISE(IGNORE); END");
    const before = await readFile(file);
    await expect(record()).rejects.toThrow();
    expect(await readFile(file)).toEqual(before);
  });

  it("preserves a previously committed run on duplicate IDs",async () => {
    await record();
    const before = await readFile(file);
    await expect(record()).rejects.toThrow();
    expect(await readFile(file)).toEqual(before);
  });

  it("allows exactly one writer when generated run IDs collide concurrently",async () => {
    const result = await Promise.allSettled([record(),record()]);
    expect(result.map(item => item.status).sort()).toEqual(["fulfilled","rejected"]);
    for (const table of ["query_runs","run_reviews","audit_events"]) {
      expect(await jobSqlite(file,"readonly-first",`SELECT count(*) n FROM ${table}`)).toEqual({n:1});
    }
  },20000);

  it("keeps a committed transaction after its acknowledgement is lost, without retry or compensation",async () => {
    const batch = db.batch.bind(db), failure = new Error("Synthetic lost acknowledgment");
    const spy = vi.spyOn(db,"batch").mockImplementation(async statements => {await batch(statements);throw failure;});
    await expect(record()).rejects.toBe(failure);
    expect(spy).toHaveBeenCalledTimes(1);
    const stored = await state();
    expect(stored.query.id).toBe(runId);
    expect(stored.review.id).toBe(runId);
    expect(stored.audit.target).toBe(runId);
  });

  it("keeps the no-binding preview explicitly unpersisted",async () => {
    const before = await readFile(file);
    expect(await recordQueryDryRun({},input)).toEqual({id:runId,persisted:false,storageBinding:null});
    expect(await readFile(file)).toEqual(before);
  });
});
