import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { jobDatabase, jobSqlite, jobTransactionalDatabase } from "./fixtures/job-sqlite";
import { postgresConcurrencyCases } from "./fixtures/postgresql-concurrency-cases";
import { approvePostgresFixture, pgAccess, pgRun, publishPostgresFixture, seedPostgresControl } from "./fixtures/postgresql-control";
import { claimPostgresRead, inspectPostgresRead, preparePostgresDispatch } from "../lib/postgresql-control";

let dir: string;
const db = () => jobTransactionalDatabase(() => join(dir, "control.db"));
describe("PostgreSQL durable concurrency on SQLite", { timeout: 30000 }, () => {
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "odap-pg-concurrency-"));
    await jobSqlite(join(dir, "control.db"), "setup"); await seedPostgresControl(db(), undefined, 10, undefined, null);
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
  postgresConcurrencyCases(db);
  it("retains unresolved reservations after authority expiry", async () => {
    const database = db(); await pgRun(database, "INSERT INTO postgresql_concurrency_limits VALUES('tenant-a','budget',1)");
    await publishPostgresFixture(database); await approvePostgresFixture(database);
    const { row } = await preparePostgresDispatch(pgAccess(database), "request");
    await claimPostgresRead(pgAccess(database), row, "one");
    const expired = jobDatabase(() => join(dir, "control.db"), "readonly-after-expiry");
    expect(await inspectPostgresRead(pgAccess(expired), "request")).toMatchObject({ unresolved_claims: 1, used_attempts: 1 });
  });
  it("upgrades populated v37 without rewriting history or forgetting unresolved claims", async () => {
    const file = join(dir, "v37.db"); await jobSqlite(file, "setup-v37"); const database = jobTransactionalDatabase(() => file);
    await seedPostgresControl(database); await publishPostgresFixture(database); await approvePostgresFixture(database);
    await approvePostgresFixture(database, "second");
    const { row } = await preparePostgresDispatch(pgAccess(database), "request");
    await claimPostgresRead(pgAccess(database), row, "old-attempt");
    const sql = "SELECT json_group_array(payload) AS objects FROM (SELECT payload FROM approval_contracts UNION ALL SELECT payload FROM evidence_receipts)";
    const before = await jobSqlite(file, "readonly-first", sql); await jobSqlite(file, "apply-postgresql-concurrency");
    await jobSqlite(file, "apply-postgresql-cancellation");
    expect(await jobSqlite(file, "readonly-first", sql)).toEqual(before);
    expect(await inspectPostgresRead(pgAccess(database), "request")).toMatchObject({ unresolved_claims: 1, limit_in_flight: null });
    const second = (await preparePostgresDispatch(pgAccess(database), "second")).row;
    await expect(claimPostgresRead(pgAccess(database), second, "two")).rejects.toThrow();
    await pgRun(database, "INSERT INTO postgresql_concurrency_limits VALUES('tenant-a','budget',1)");
    await expect(claimPostgresRead(pgAccess(database), second, "two")).rejects.toThrow();
    expect(await jobSqlite(file, "readonly-first", "PRAGMA foreign_key_check")).toBeNull();
  });
});
