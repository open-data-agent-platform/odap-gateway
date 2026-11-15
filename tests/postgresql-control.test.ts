import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { jobDatabase, jobSqlite, jobTransactionalDatabase } from "./fixtures/job-sqlite";
import { approvePostgresFixture, pgAccess, publishPostgresFixture, seedPostgresControl } from "./fixtures/postgresql-control";
import { postgresControlCases } from "./fixtures/postgresql-control-cases";
import { inspectPostgresRead, preparePostgresDispatch } from "../lib/postgresql-control";

let dir: string;
const db = () => jobTransactionalDatabase(() => join(dir, "control.db"));
describe("PostgreSQL durable control on SQLite", { timeout: 30000 }, () => {
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "odap-pg-control-"));
    await jobSqlite(join(dir, "control.db"), "setup");
    await seedPostgresControl(db());
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
  postgresControlCases(db);
  it("refuses expired authority while preserving read-only recovery", async () => {
    await publishPostgresFixture(db()); await approvePostgresFixture(db());
    const expired = jobDatabase(() => join(dir, "control.db"), "readonly-after-expiry");
    await expect(preparePostgresDispatch(pgAccess(expired), "request")).rejects.toThrow();
    expect(await inspectPostgresRead(pgAccess(expired), "request")).toMatchObject({ used_attempts: 0 });
  });
  it("upgrades populated v34 without modifying any existing control object", async () => {
    const path = join(dir, "legacy.db");
    await jobSqlite(path, "setup-v34");
    const read = "SELECT json_group_array(payload) AS objects FROM (SELECT payload FROM semantic_releases UNION ALL SELECT payload FROM approval_contracts)";
    const before = await jobSqlite(path, "readonly-first", read);
    await jobSqlite(path, "apply-postgresql-control");
    expect(await jobSqlite(path, "readonly-first", read)).toEqual(before);
    expect(await jobSqlite(path, "readonly-first", "SELECT count(*) AS n FROM postgresql_source_versions")).toEqual({ n: 0 });
    expect(await jobSqlite(path, "readonly-first", "PRAGMA foreign_key_check")).toBeNull();
  });
});
