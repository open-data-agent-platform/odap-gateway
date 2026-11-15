import { expect, it } from "vitest";
import type { D1Database } from "../../lib/d1";
import { claimPostgresRead, inspectPostgresRead, observePostgresRead, preparePostgresDispatch, stopPostgresRead } from "../../lib/postgresql-control";
import { recordPostgresFailure } from "../../lib/postgresql-terminal";
import { inspectPostgresAgent, verifyPostgresAgent } from "../../lib/postgresql-agent";
import { approvePostgresFixture, pgAccess, pgRun, publishPostgresFixture } from "./postgresql-control";
import { approvePostgresAgentFixture, pgAgentOrigin } from "./postgresql-agent";

export function postgresConcurrencyCases(getDb: () => D1Database) {
  async function prepare(configure = true) {
    const db = getDb();
    if (configure) await pgRun(db, "INSERT INTO postgresql_concurrency_limits VALUES('tenant-a','budget',1)");
    await publishPostgresFixture(db); await approvePostgresFixture(db); await approvePostgresFixture(db, "second");
    const first = (await preparePostgresDispatch(pgAccess(db), "request")).row;
    const second = (await preparePostgresDispatch(pgAccess(db), "second")).row;
    return { db, first, second };
  }
  it("atomically admits only one of two different requests sharing capacity", async () => {
    const { db, first, second } = await prepare();
    const results = await Promise.allSettled([claimPostgresRead(pgAccess(db), first, "one"), claimPostgresRead(pgAccess(db), second, "two")]);
    expect(results.filter(r => r.status === "fulfilled" && r.value === true)).toHaveLength(1);
    expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
    expect(await inspectPostgresRead(pgAccess(db), "request")).toMatchObject({ used_attempts: 1, unresolved_claims: 1, limit_in_flight: 1 });
    expect(await db.prepare("SELECT count(*) AS n FROM evidence_receipts WHERE tenant_id='tenant-a'").bind().first()).toEqual({ n: 1 });
    expect(await db.prepare("SELECT count(*) AS n FROM contract_lifecycle WHERE tenant_id='tenant-a' AND state='authorized'").bind().first()).toEqual({ n: 1 });
  });
  it("fails closed without explicit resource provisioning and consumes nothing", async () => {
    const { db, first } = await prepare(false);
    await expect(claimPostgresRead(pgAccess(db), first, "one")).rejects.toThrow();
    expect(await inspectPostgresRead(pgAccess(db), "request")).toMatchObject({ limit_in_flight: null, unresolved_claims: 0, used_attempts: 0 });
  });
  it("releases confirmed success capacity without refunding or rearming its attempt", async () => {
    const { db, first, second } = await prepare(); await claimPostgresRead(pgAccess(db), first, "one");
    await observePostgresRead(pgAccess(db), "request", "one", "succeeded");
    expect(await inspectPostgresRead(pgAccess(db), "request")).toMatchObject({ unresolved_claims: 0, used_attempts: 1 });
    expect(await claimPostgresRead(pgAccess(db), second, "two")).toBe(true);
    expect(await claimPostgresRead(pgAccess(db), first, "replay")).toBe(false);
    expect(await inspectPostgresRead(pgAccess(db), "second")).toMatchObject({ unresolved_claims: 1, used_attempts: 2 });
  });
  it.each(["57014", "42501"] as const)("releases only acknowledged %s failure capacity", async code => {
    const { db, first, second } = await prepare(); await claimPostgresRead(pgAccess(db), first, "one");
    await recordPostgresFailure(pgAccess(db), "request", "one", first.statement_digest, code);
    expect(await inspectPostgresRead(pgAccess(db), "request")).toMatchObject({ unresolved_claims: 0, used_attempts: 1, monetaryCost: "unpriced" });
    expect(await claimPostgresRead(pgAccess(db), second, "two")).toBe(true);
  });
  it("retains unresolved capacity after a pending observation and a stop request", async () => {
    const { db, first, second } = await prepare(); await claimPostgresRead(pgAccess(db), first, "one");
    await observePostgresRead(pgAccess(db), "request", "one", "observation-required");
    await stopPostgresRead(pgAccess(db), "request");
    await expect(claimPostgresRead(pgAccess(db), second, "two")).rejects.toThrow();
    expect(await inspectPostgresRead(pgAccess(db), "request")).toMatchObject({ unresolved_claims: 1, used_attempts: 1, state: "observation-required" });
  });
  it.each(["succeeded", "failed"])("does not release capacity when the %s receipt insertion rolls back", async outcome => {
    const { db, first, second } = await prepare(); await claimPostgresRead(pgAccess(db), first, "one");
    await pgRun(db, `CREATE TRIGGER resource_terminal_failure BEFORE INSERT ON evidence_receipts
      WHEN NEW.id='${outcome === "succeeded" ? "pg-observed-one" : "pg-failed-one"}' BEGIN SELECT RAISE(ABORT,'synthetic'); END`);
    await expect(outcome === "succeeded" ? observePostgresRead(pgAccess(db), "request", "one", "succeeded") :
      recordPostgresFailure(pgAccess(db), "request", "one", first.statement_digest, "57014")).rejects.toThrow();
    await expect(claimPostgresRead(pgAccess(db), second, "two")).rejects.toThrow();
    expect(await inspectPostgresRead(pgAccess(db), "request")).toMatchObject({ unresolved_claims: 1 });
  });
  it("rolls back the reservation and contract when pending receipt insertion fails", async () => {
    const { db, first, second } = await prepare();
    await pgRun(db, "CREATE TRIGGER resource_claim_failure BEFORE INSERT ON evidence_receipts WHEN NEW.id='pg-pending-one' BEGIN SELECT RAISE(ABORT,'synthetic'); END");
    await expect(claimPostgresRead(pgAccess(db), first, "one")).rejects.toThrow();
    expect(await inspectPostgresRead(pgAccess(db), "request")).toMatchObject({ unresolved_claims: 0, used_attempts: 0 });
    expect(await claimPostgresRead(pgAccess(db), second, "two")).toBe(true);
  });
  it("requires bounded integer limits and rejects mutation deletion and replacement", async () => {
    const db = getDb();
    for (const value of [0, -1, 1001, 1.5, "invalid"]) await expect(pgRun(db,
      "INSERT INTO postgresql_concurrency_limits VALUES('tenant-a','budget',?)", [value])).rejects.toThrow();
    await pgRun(db, "INSERT INTO postgresql_concurrency_limits VALUES('tenant-a','budget',1)");
    for (const sql of ["UPDATE postgresql_concurrency_limits SET limit_in_flight=2", "DELETE FROM postgresql_concurrency_limits",
      "INSERT OR REPLACE INTO postgresql_concurrency_limits VALUES('tenant-a','budget',2)"])
      await expect(pgRun(db, sql)).rejects.toThrow();
    expect(await db.prepare("PRAGMA foreign_key_check").bind().first()).toBeNull();
  });
  it("isolates equal budget identifiers across tenants and keeps inspection authorized", async () => {
    const { db, first } = await prepare(); await claimPostgresRead(pgAccess(db), first, "one");
    await pgRun(db, "INSERT INTO postgresql_read_budgets VALUES('tenant-b','budget',10)");
    await pgRun(db, "INSERT INTO postgresql_concurrency_limits VALUES('tenant-b','budget',2)");
    expect(await db.prepare("SELECT limit_in_flight,unresolved_claims FROM postgresql_resource_usage WHERE tenant_id='tenant-b'").bind().first())
      .toEqual({ limit_in_flight: 2, unresolved_claims: 0 });
    await expect(inspectPostgresRead(pgAccess(db, "reader", "tenant-b"), "request")).rejects.toThrow();
    await expect(inspectPostgresRead(pgAccess(db, "other-reader"), "request")).rejects.toThrow();
  });
  it.each([false, true])("shares capacity between session and signed Agent claims (Agent wins=%s)", async agentWins => {
    const { db, first } = await prepare(); const a = await approvePostgresAgentFixture(db);
    const verified = await verifyPostgresAgent(db, pgAgentOrigin, "tenant-a", a.delegationId, a.signature, "execute");
    const agentRow = (await preparePostgresDispatch(verified.access, verified.requestId, verified.proof)).row;
    const agentClaim = () => claimPostgresRead(verified.access, agentRow, "agent-attempt", verified.proof);
    const sessionClaim = () => claimPostgresRead(pgAccess(db), first, "one");
    expect(await (agentWins ? agentClaim() : sessionClaim())).toBe(true);
    await expect(agentWins ? sessionClaim() : agentClaim()).rejects.toThrow();
    const inspecting = await verifyPostgresAgent(db, pgAgentOrigin, "tenant-a", a.delegationId, a.inspectSignature, "inspect");
    expect(await inspectPostgresAgent(inspecting.access, inspecting.proof)).toMatchObject({ limitInFlight: 1, unresolvedClaims: 1,
      resourceUnit: "unresolved-read-claim", monetaryCost: "unpriced" });
  });
}
