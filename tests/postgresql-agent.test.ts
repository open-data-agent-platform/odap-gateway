import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { jobDatabase, jobSqlite, jobTransactionalDatabase } from "./fixtures/job-sqlite";
import { pgAccess, pgAction, pgRun, publishPostgresFixture, seedPostgresControl } from "./fixtures/postgresql-control";
import { postgresAgentCases } from "./fixtures/postgresql-agent-cases";
import { approvePostgresAgentFixture, pgAgentOrigin } from "./fixtures/postgresql-agent";
import { verifyPostgresAgent } from "../lib/postgresql-agent";
import { claimPostgresRead, inspectPostgresRead, preparePostgresDispatch, requestPostgresRead } from "../lib/postgresql-control";

let dir: string;
const db = () => jobTransactionalDatabase(() => join(dir, "control.db"));
describe("PostgreSQL scoped Agent delegation on SQLite", { timeout: 30000 }, () => {
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "odap-pg-agent-"));
    await jobSqlite(join(dir, "control.db"), "setup"); await seedPostgresControl(db());
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
  postgresAgentCases(db);
  it("rejects expired signed authority while retaining human recovery", async () => {
    const database = db(); await publishPostgresFixture(database); const a = await approvePostgresAgentFixture(database);
    const expired = jobDatabase(() => join(dir, "control.db"), "readonly-after-expiry");
    await expect(verifyPostgresAgent(expired, pgAgentOrigin, "tenant-a", a.delegationId, a.signature, "execute")).rejects.toThrow();
    await expect(verifyPostgresAgent(expired, pgAgentOrigin, "tenant-a", a.delegationId, a.inspectSignature, "inspect")).rejects.toThrow();
    expect(await inspectPostgresRead(pgAccess(expired), "agent-request")).toMatchObject({ used_attempts: 0 });
  });
  it("upgrades populated v35 preserving existing session contracts and their execution eligibility", async () => {
    const file = join(dir, "v35.db"); await jobSqlite(file, "setup-v35");
    const database = jobTransactionalDatabase(() => file);
    await seedPostgresControl(database); await publishPostgresFixture(database);
    await requestPostgresRead(pgAccess(database), { requestId: "session", releaseId: "release", action: pgAction });
    await pgRun(database, `INSERT INTO postgresql_read_approvals(tenant_id,request_id,contract_id,approved_by)
      VALUES('tenant-a','session','prior-contract','google:owner')`);
    const snapshot = "SELECT json_group_array(payload) AS objects FROM (SELECT payload FROM semantic_releases UNION ALL SELECT payload FROM approval_contracts)";
    const before = await jobSqlite(file, "readonly-first", snapshot);
    await jobSqlite(file, "apply-postgresql-agents");
    expect(await jobSqlite(file, "readonly-first", snapshot)).toEqual(before);
    const { row } = await preparePostgresDispatch(pgAccess(database), "session");
    expect(row.delegation_id).toBeNull(); expect(await claimPostgresRead(pgAccess(database), row, "attempt")).toBe(true);
    expect(await jobSqlite(file, "readonly-first", "PRAGMA foreign_key_check")).toBeNull();
  });
});
