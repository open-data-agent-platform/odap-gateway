import { expect, it } from "vitest";
import type { D1Database } from "../../lib/d1";
import { isApprovalContract, isEvidenceReceipt } from "../../lib/control-objects";
import { approvePostgresRead, claimPostgresRead, inspectPostgresRead, observePostgresRead, preparePostgresDispatch,
  proposePostgresRevision, requestPostgresRead, stopPostgresRead } from "../../lib/postgresql-control";
import { retireSemanticRelease } from "../../lib/semantic-candidate-storage";
import { pgAccess, pgAction, pgRun, publishPostgresFixture, approvePostgresFixture } from "./postgresql-control";
import { postgresDefinition } from "./postgresql";

export function postgresControlCases(getDb: () => D1Database) {
  const db = () => getDb();
  const count = (table: string) => db().prepare(`SELECT count(*) AS n FROM ${table}`).bind().first<{ n: number }>();
  const prepared = () => preparePostgresDispatch(pgAccess(db()), "request");
  const start = async () => { await publishPostgresFixture(db()); await approvePostgresFixture(db()); };

  it("publishes only reviewed semantics, issues a bound contract and records an immutable receipt chain", async () => {
    await start();
    const { row } = await prepared();
    const contract = await db().prepare("SELECT payload FROM approval_contracts WHERE id=?").bind(row.contract_id).first<{ payload: string }>();
    expect(isApprovalContract(JSON.parse(contract!.payload))).toBe(true);
    expect(await claimPostgresRead(pgAccess(db()), row, "attempt")).toBe(true);
    expect(await observePostgresRead(pgAccess(db()), "request", "attempt", "succeeded")).toBe(true);
    const history = await inspectPostgresRead(pgAccess(db()), "request");
    expect(history).toMatchObject({ state: "succeeded", used_attempts: 1, budgetUnit: "read-attempt", monetaryCost: "unpriced" });
    for (const id of history.receiptIds) {
      const receipt = await db().prepare("SELECT payload FROM evidence_receipts WHERE tenant_id='tenant-a' AND id=?")
        .bind(id).first<{ payload: string }>();
      expect(isEvidenceReceipt(JSON.parse(receipt!.payload))).toBe(true);
    }
    expect(history.receiptIds).toHaveLength(2);
    expect(await db().prepare("PRAGMA foreign_key_check").bind().first()).toBeNull();
  });

  it.each(["reader", "other-owner"])("refuses %s publishing as the resource owner", async actor => {
    const proposal = { revisionId: "bad", provenanceRef: "synthetic", definition: postgresDefinition };
    if (actor === "reader") await expect(proposePostgresRevision(pgAccess(db(), actor), proposal)).rejects.toThrow();
    else {
      await publishPostgresFixture(db());
      await requestPostgresRead(pgAccess(db()), { requestId: "request", releaseId: "release", action: pgAction });
      await expect(approvePostgresRead(pgAccess(db(), actor), { requestId: "request", releaseId: "release", sourceId: "revision-1",
        requesterId: "google:reader", reviewedAction: pgAction })).rejects.toThrow();
    }
    expect(await count("postgresql_read_approvals")).toEqual({ n: 0 });
  });

  it.each(["tenant", "principal", "owner"])("does not borrow a request using another %s", async kind => {
    await start();
    const access = kind === "tenant" ? pgAccess(db(), "reader", "tenant-b") : pgAccess(db(), kind === "owner" ? "other-owner" : "other-reader");
    await expect(inspectPostgresRead(access, "request")).rejects.toThrow();
    await expect(preparePostgresDispatch(access, "request")).rejects.toThrow();
    await expect(stopPostgresRead(access, "request")).rejects.toThrow();
    expect(await count("postgresql_read_claims")).toEqual({ n: 0 });
  });

  it("requires the exact reviewed action and rejects self-approval", async () => {
    await publishPostgresFixture(db());
    await requestPostgresRead(pgAccess(db()), { requestId: "request", releaseId: "release", action: pgAction });
    await expect(approvePostgresRead(pgAccess(db(), "owner"), { requestId: "request", releaseId: "release", sourceId: "revision-1",
      requesterId: "google:reader", reviewedAction: { ...pgAction, metricId: "different" } })).rejects.toThrow();
    await requestPostgresRead(pgAccess(db(), "owner"), { requestId: "own", releaseId: "release", action: pgAction });
    await expect(approvePostgresRead(pgAccess(db(), "owner"), { requestId: "own", releaseId: "release", sourceId: "revision-1",
      requesterId: "google:owner", reviewedAction: pgAction })).rejects.toThrow();
  });

  it.each(["head", "reader", "owner", "retired", "stop", "contract"])("rechecks %s immediately in the final claim", async change => {
    await start(); const { row } = await prepared();
    if (change === "head") await pgRun(db(), "UPDATE postgresql_source_heads SET active=0");
    else if (change === "reader" || change === "owner") await pgRun(db(),
      "UPDATE control_memberships SET active=0 WHERE tenant_id='tenant-a' AND principal_id=?", ["google:" + change]);
    else if (change === "retired") await retireSemanticRelease(pgAccess(db(), "owner"), "release", "synthetic stop");
    else if (change === "stop") await stopPostgresRead(pgAccess(db()), "request");
    else await pgRun(db(), "UPDATE contract_lifecycle SET state='revoked' WHERE tenant_id='tenant-a'");
    expect(await claimPostgresRead(pgAccess(db()), row, "attempt")).toBe(false);
    expect(await count("postgresql_read_claims")).toEqual({ n: 0 });
    expect(await count("postgresql_read_observations")).toEqual({ n: 0 });
  });

  it("admits one winner across concurrent processes without reusing an approval", async () => {
    await start(); const { row } = await prepared();
    const results = await Promise.allSettled(["attempt-a", "attempt-b", "attempt-c"].map(id => claimPostgresRead(pgAccess(db()), row, id)));
    expect(results.filter(r => r.status === "fulfilled" && r.value)).toHaveLength(1);
    expect(await count("postgresql_read_claims")).toEqual({ n: 1 });
    expect(await inspectPostgresRead(pgAccess(db()), "request")).toMatchObject({ state: "observation-required", used_attempts: 1 });
    expect(await claimPostgresRead(pgAccess(db()), row, "attempt-again")).toBe(false);
  });

  it("enforces a shared attempt quota, including unconfirmed executions", async () => {
    await start();
    for (const requestId of ["request", "request-2"]) {
      if (requestId !== "request") await approvePostgresFixture(db(), requestId);
      const { row } = await preparePostgresDispatch(pgAccess(db()), requestId);
      expect(await claimPostgresRead(pgAccess(db()), row, "attempt-" + requestId)).toBe(true);
      await observePostgresRead(pgAccess(db()), requestId, "attempt-" + requestId, "observation-required");
    }
    await approvePostgresFixture(db(), "request-3");
    await expect(preparePostgresDispatch(pgAccess(db()), "request-3")).rejects.toThrow();
    expect(await inspectPostgresRead(pgAccess(db()), "request-3")).toMatchObject({ used_attempts: 2, limit_attempts: 2 });
  });

  it("keeps recovery read-only after retirement and does not claim stop means cancellation", async () => {
    await start(); const { row } = await prepared();
    await claimPostgresRead(pgAccess(db()), row, "attempt");
    await retireSemanticRelease(pgAccess(db(), "owner"), "release", "synthetic");
    expect(await stopPostgresRead(pgAccess(db()), "request")).toMatchObject({ cancellationConfirmed: false });
    expect(await inspectPostgresRead(pgAccess(db()), "request")).toMatchObject({ state: "observation-required" });
    expect(await observePostgresRead(pgAccess(db()), "request", "attempt", "succeeded")).toBe(true);
    await expect(observePostgresRead(pgAccess(db()), "request", "attempt", "succeeded")).rejects.toThrow();
  });

  it("rolls back claim and contract consumption if pending receipt insertion fails", async () => {
    await start(); const { row } = await prepared();
    await pgRun(db(), `CREATE TRIGGER synthetic_receipt_fault BEFORE INSERT ON evidence_receipts
      BEGIN SELECT RAISE(ABORT,'synthetic failure'); END`);
    await expect(claimPostgresRead(pgAccess(db()), row, "attempt")).rejects.toThrow();
    expect(await count("postgresql_read_claims")).toEqual({ n: 0 });
    expect(await prepared()).toMatchObject({ row: { id: "request" } });
  });

  it("preserves claims, quotas and evidence against updates, deletes and REPLACE", async () => {
    await start(); const { row } = await prepared();
    await claimPostgresRead(pgAccess(db()), row, "attempt");
    await observePostgresRead(pgAccess(db()), "request", "attempt", "succeeded");
    await stopPostgresRead(pgAccess(db()), "request");
    for (const table of ["postgresql_read_budgets", "postgresql_source_versions", "postgresql_read_requests",
      "postgresql_read_approvals", "postgresql_read_claims", "postgresql_read_observations", "postgresql_read_stops"]) {
      await expect(pgRun(db(), `UPDATE ${table} SET tenant_id=tenant_id`)).rejects.toThrow();
      await expect(pgRun(db(), `DELETE FROM ${table}`)).rejects.toThrow();
      await expect(pgRun(db(), `INSERT OR REPLACE INTO ${table} SELECT * FROM ${table}`)).rejects.toThrow();
    }
    expect(await count("postgresql_read_claims")).toEqual({ n: 1 });
  });
}
