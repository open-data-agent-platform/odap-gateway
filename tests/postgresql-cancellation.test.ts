import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { jobDatabase, jobSqlite, jobTransactionalDatabase } from "./fixtures/job-sqlite";
import { postgresCancellationCases } from "./fixtures/postgresql-cancellation-cases";
import { approvePostgresFixture, pgAccess, publishPostgresFixture, seedPostgresControl } from "./fixtures/postgresql-control";
import { cancelPostgresRead, claimPostgresRead, inspectPostgresRead, preparePostgresDispatch } from "../lib/postgresql-control";

let dir: string;
const db = () => jobTransactionalDatabase(() => join(dir, "control.db"));
describe("PostgreSQL cancellation intent on SQLite", { timeout: 30000 }, () => {
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "odap-pg-cancel-"));
    await jobSqlite(join(dir, "control.db"), "setup"); await seedPostgresControl(db());
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
  postgresCancellationCases(db);
  it("upgrades populated v38 without changing evidence and retains pending intent after expiry", async () => {
    const file = join(dir, "v38.db"); await jobSqlite(file, "setup-v38"); const database = jobTransactionalDatabase(() => file);
    await seedPostgresControl(database); await publishPostgresFixture(database); await approvePostgresFixture(database);
    const { row } = await preparePostgresDispatch(pgAccess(database), "request"); await claimPostgresRead(pgAccess(database), row, "one");
    const sql = "SELECT json_group_array(payload) AS objects FROM (SELECT payload FROM approval_contracts UNION ALL SELECT payload FROM evidence_receipts)";
    const before = await jobSqlite(file, "readonly-first", sql); await jobSqlite(file, "apply-postgresql-cancellation");
    expect(await jobSqlite(file, "readonly-first", sql)).toEqual(before);
    await cancelPostgresRead(pgAccess(database), "request");
    const expired = jobDatabase(() => file, "readonly-after-expiry");
    expect(await inspectPostgresRead(pgAccess(expired), "request")).toMatchObject({ cancellation_requested_at: expect.any(String), unresolved_claims: 1 });
    expect(await jobSqlite(file, "readonly-first", "PRAGMA foreign_key_check")).toBeNull();
  });
});
