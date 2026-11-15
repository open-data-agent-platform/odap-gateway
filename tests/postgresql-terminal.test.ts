import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { jobSqlite, jobTransactionalDatabase } from "./fixtures/job-sqlite";
import { postgresTerminalCases } from "./fixtures/postgresql-terminal-cases";
import { approvePostgresFixture, pgAccess, publishPostgresFixture, seedPostgresControl } from "./fixtures/postgresql-control";
import { claimPostgresRead, inspectPostgresRead, observePostgresRead, preparePostgresDispatch } from "../lib/postgresql-control";

let dir: string;
const db = () => jobTransactionalDatabase(() => join(dir, "control.db"));
describe("PostgreSQL acknowledged terminal failures on SQLite", { timeout: 30000 }, () => {
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "odap-pg-terminal-"));
    await jobSqlite(join(dir, "control.db"), "setup"); await seedPostgresControl(db());
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
  postgresTerminalCases(db);
  it("upgrades a populated v36 ledger without changing prior successful receipts or claims", async () => {
    const file = join(dir, "v36.db"); await jobSqlite(file, "setup-v36");
    const database = jobTransactionalDatabase(() => file);
    await seedPostgresControl(database); await publishPostgresFixture(database); await approvePostgresFixture(database);
    const { row } = await preparePostgresDispatch(pgAccess(database), "request");
    await claimPostgresRead(pgAccess(database), row, "attempt"); await observePostgresRead(pgAccess(database), "request", "attempt", "succeeded");
    const sql = "SELECT json_group_array(payload) AS objects FROM (SELECT payload FROM approval_contracts UNION ALL SELECT payload FROM evidence_receipts)";
    const before = await jobSqlite(file, "readonly-first", sql); await jobSqlite(file, "apply-postgresql-terminals");
    await jobSqlite(file, "apply-postgresql-concurrency");
    expect(await jobSqlite(file, "readonly-first", sql)).toEqual(before);
    expect(await inspectPostgresRead(pgAccess(database), "request")).toMatchObject({ state: "succeeded", used_attempts: 1, terminal_sql_state: null });
    expect(await jobSqlite(file, "readonly-first", "PRAGMA foreign_key_check")).toBeNull();
  });
});
