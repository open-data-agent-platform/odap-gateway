import { expect, it } from "vitest";
import type { D1Database } from "../../lib/d1";
import { exportPostgresDenialEvidence } from "../../lib/postgresql-denial-evidence-export";
import { verifyPostgresDenialEvidence } from "../../lib/postgresql-denial-evidence";
import { requestPostgresRead } from "../../lib/postgresql-control";
import { recordMissingReleaseDenial } from "../../lib/preapproval-denial";
import { pgAccess, pgAction, pgRun, publishPostgresFixture } from "./postgresql-control";

export function postgresDenialExportCases(database: () => D1Database) {
  const denied = async (releaseId = "missing") => {
    await expect(requestPostgresRead(pgAccess(database()), { requestId: "request", releaseId,
      action: { ...pgAction, parameters: { private: "synthetic-secret-filter" } } })).rejects.toThrow();
    return (await database().prepare("SELECT attempt_id FROM missing_release_denials").first<{ attempt_id: string }>())!.attempt_id;
  };
  const exported = async (attemptId: string) => exportPostgresDenialEvidence(pgAccess(database(), "owner"), attemptId);
  it("exports an attributed denial and creation event with no action values or new writes", async () => {
    const attemptId = await denied(), bundle = await exported(attemptId);
    expect(await verifyPostgresDenialEvidence(bundle.json, { tenantId: "tenant-a", attemptId }, bundle.digest))
      .toMatchObject({ recordedDecision: "denied", authorizationGranted: false, executionVerified: false });
    expect(bundle.json).not.toContain("synthetic-secret-filter");
    expect(JSON.parse(bundle.json).denial.principalId).toBe("google:reader");
    expect(await database().prepare("SELECT count(*) AS n FROM control_object_events").first("n")).toBe(1);
    for (const table of ["postgresql_read_requests", "postgresql_read_claims", "execution_intents", "approval_contracts"])
      expect(await database().prepare(`SELECT count(*) AS n FROM ${table}`).first("n")).toBe(0);
    expect(await exported(attemptId)).toEqual(bundle);
  });
  it("allows any current tenant owner because a missing release has no source owner", async () => {
    const attemptId = await denied();
    expect(await exportPostgresDenialEvidence(pgAccess(database(), "other-owner"), attemptId)).toEqual(await exported(attemptId));
  });
  it.each(["reader", "reviewer", "unknown", "cross-tenant", "inactive-owner", "downgraded-owner"])("refuses %s denial export", async mode => {
    const attemptId = await denied(), db = database();
    if (mode === "inactive-owner") await pgRun(db, "UPDATE control_memberships SET active=0 WHERE tenant_id='tenant-a' AND principal_id='google:owner'");
    if (mode === "downgraded-owner") await pgRun(db, "UPDATE control_memberships SET role='reader' WHERE tenant_id='tenant-a' AND principal_id='google:owner'");
    const principal = ["reader", "reviewer", "unknown"].includes(mode) ? mode : "owner";
    await expect(exportPostgresDenialEvidence(pgAccess(db, principal, mode === "cross-tenant" ? "tenant-b" : "tenant-a"), attemptId)).rejects.toThrow();
  });
  it("retains the historical denial after later publication and original actor deactivation", async () => {
    const attemptId = await denied("release"), before = await exported(attemptId);
    await publishPostgresFixture(database());
    await pgRun(database(), "UPDATE control_memberships SET active=0 WHERE tenant_id='tenant-a' AND principal_id='google:reader'");
    expect(await exported(attemptId)).toEqual(before);
  });
  it("rejects other-engine attribution even with a PostgreSQL-looking attempt ID", async () => {
    const attemptId = "pg-missing-12345678-1234-4234-8234-123456789abc";
    const { target, metricId, parameters } = pgAction;
    await recordMissingReleaseDenial(pgAccess(database()), attemptId, "other-agent", "missing", { target, metricId, parameters });
    await expect(exported(attemptId)).rejects.toThrow();
  });
  it("rejects absent attempts and malformed identifiers", async () => {
    for (const id of ["pg-missing-12345678-1234-4234-8234-123456789abc", "request", "' OR 1=1--", "", "x".repeat(200)])
      await expect(exported(id)).rejects.toThrow();
  });
  it("uses one read-only snapshot and rechecks owner status within that query", async () => {
    const attemptId = await denied(), queries: string[] = [], db = database();
    const wrapped = { prepare(sql: string) { queries.push(sql); expect(sql.trim().startsWith("SELECT ")).toBe(true); return db.prepare(sql); } } as D1Database;
    await pgRun(db, "UPDATE control_memberships SET role='reader' WHERE tenant_id='tenant-a' AND principal_id='google:owner'");
    await expect(exportPostgresDenialEvidence(pgAccess(wrapped, "owner"), attemptId)).rejects.toThrow();
    expect(queries).toHaveLength(1);
  });
  it("refuses a restored snapshot with a missing creation event", async () => {
    const attemptId = await denied(), db = database();
    await pgRun(db, "DROP TRIGGER control_event_no_delete");
    await pgRun(db, "DELETE FROM control_object_events WHERE object_kind='receipt'");
    await expect(exported(attemptId)).rejects.toThrow();
  });
  it("refuses a restored snapshot with duplicate creation events", async () => {
    const attemptId = await denied(), db = database();
    await pgRun(db, "DROP TRIGGER control_event_append_guard");
    await pgRun(db, `INSERT INTO control_object_events(tenant_id,object_kind,object_id,actor,recorded_at)
      SELECT tenant_id,object_kind,object_id,actor,recorded_at FROM control_object_events WHERE object_kind='receipt'`);
    await expect(exported(attemptId)).rejects.toThrow();
  });
  it("refuses a restored snapshot with changed creation attribution", async () => {
    const attemptId = await denied(), db = database();
    await pgRun(db, "DROP TRIGGER control_event_no_update");
    await pgRun(db, "UPDATE control_object_events SET actor='google:owner' WHERE object_kind='receipt'");
    await expect(exported(attemptId)).rejects.toThrow();
  });
}
