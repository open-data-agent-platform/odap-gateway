import { expect, it } from "vitest";
import type { D1Database } from "../../lib/d1";
import { exportPostgresEvidence } from "../../lib/postgresql-evidence-export";
import { verifyPostgresEvidence } from "../../lib/postgresql-evidence";
import { cancelPostgresRead, claimPostgresRead, observePostgresRead, preparePostgresDispatch } from "../../lib/postgresql-control";
import { recordPostgresFailure } from "../../lib/postgresql-terminal";
import { approvePostgresFixture, pgAccess, pgRun, publishPostgresFixture } from "./postgresql-control";

export function postgresEvidenceCases(database: () => D1Database) {
  const scope = { tenantId: "tenant-a", requestId: "request", intentId: "intent" };
  const claimed = async () => {
    const db = database(); await publishPostgresFixture(db); await approvePostgresFixture(db);
    const access = pgAccess(db), { row } = await preparePostgresDispatch(access, "request");
    expect(await claimPostgresRead(access, row, "intent")).toBe(true); return { db, access, row };
  };
  const exported = async () => {
    const bundle = await exportPostgresEvidence(pgAccess(database(), "owner"), "request");
    return { ...bundle, verification: await verifyPostgresEvidence(bundle.json, scope, bundle.digest) };
  };
  it("exports the original pending claim without releasing resources", async () => {
    await claimed(); const bundle = await exported();
    expect(bundle.verification).toMatchObject({ state: "observation-required", monetaryCost: "unpriced", providerVerified: false });
    expect(JSON.parse(bundle.json).receipts).toHaveLength(1);
    expect(await database().prepare("SELECT unresolved_claims AS n FROM postgresql_resource_usage").first("n")).toBe(1);
  });
  it.each(["succeeded", "observation-required"] as const)("exports the %s observation and original pending history", async outcome => {
    const { access } = await claimed(); expect(await observePostgresRead(access, "request", "intent", outcome)).toBe(true);
    const bundle = await exported(); expect(bundle.verification.state).toBe(outcome);
    expect(JSON.parse(bundle.json).receipts).toHaveLength(2);
  });
  it.each(["57014", "42501"] as const)("exports acknowledged failure %s without a cancellation or billing claim", async code => {
    const { access, row } = await claimed();
    expect(await recordPostgresFailure(access, "request", "intent", row.statement_digest, code)).toBe(true);
    expect((await exported()).verification).toMatchObject({ state: "failed", cancellationConfirmed: false, monetaryCost: "unpriced" });
  });
  it("keeps cancellation, uncertainty and subsequent failure as separate evidence", async () => {
    const { access, row } = await claimed();
    await cancelPostgresRead(access, "request"); await observePostgresRead(access, "request", "intent", "observation-required");
    expect((await exported()).verification.state).toBe("observation-required");
    await recordPostgresFailure(access, "request", "intent", row.statement_digest, "57014");
    const result = await exported(); expect(result.verification.state).toBe("failed");
    expect(JSON.parse(result.json).receipts).toHaveLength(4);
  });
  it("permits historical export after source retirement without reauthorizing execution", async () => {
    const { db } = await claimed(); await pgRun(db, "UPDATE postgresql_source_heads SET active=0 WHERE tenant_id='tenant-a'");
    expect((await exported()).verification.authorizationGranted).toBe(false);
  });
  it("refuses requests with no persisted claim", async () => {
    await publishPostgresFixture(database()); await approvePostgresFixture(database());
    await expect(exported()).rejects.toThrow();
  });
  it.each(["reader", "reviewer", "other-owner", "cross-tenant", "inactive-owner", "downgraded-owner"])("refuses %s export", async mode => {
    const { db } = await claimed();
    if (mode === "inactive-owner") await pgRun(db, "UPDATE control_memberships SET active=0 WHERE tenant_id='tenant-a' AND principal_id='google:owner'");
    if (mode === "downgraded-owner") await pgRun(db, "UPDATE control_memberships SET role='reader' WHERE tenant_id='tenant-a' AND principal_id='google:owner'");
    const principal = ["reader", "reviewer", "other-owner"].includes(mode) ? mode : "owner";
    await expect(exportPostgresEvidence(pgAccess(db, principal, mode === "cross-tenant" ? "tenant-b" : "tenant-a"), "request")).rejects.toThrow();
  });
  it("rejects duplicate receipt creation events and preserves verifiable history", async () => {
    const { db } = await claimed();
    await expect(pgRun(db, `INSERT INTO control_object_events(tenant_id,object_kind,object_id,actor)
      VALUES('tenant-a','receipt','pg-pending-intent','google:owner')`)).rejects.toThrow();
    expect((await exported()).verification.consistent).toBe(true);
  });
  it("reads exactly one snapshot with no writes or provider resolution", async () => {
    const { db } = await claimed(); const queries: string[] = [];
    const snapshot = { prepare(sql: string) { queries.push(sql); expect(sql.trim().startsWith("SELECT ")).toBe(true); return db.prepare(sql); } } as D1Database;
    const result = await exportPostgresEvidence(pgAccess(snapshot, "owner"), "request");
    expect(queries).toHaveLength(1); expect(result.digest).toMatch(/^sha256:/);
  });
}
