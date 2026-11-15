import type { D1Database, D1Value } from "../../lib/d1";
import { canonicalControlJson } from "../../lib/control-objects";
import { postgresDefinition, postgresSource } from "./postgresql";
import { approvePostgresRead, approvePostgresRevision, promotePostgresRevision, proposePostgresRevision,
  requestPostgresRead, validatePostgresRevision } from "../../lib/postgresql-control";

export const pgAction = { profile: "odap.metric-read.v1", target: "orders", metricId: "total", parameters: {} };
export const pgAccess = (db: D1Database, principal = "reader", tenantId = "tenant-a") =>
  ({ db, tenantId, principalId: "google:" + principal });
export const pgRun = (db: D1Database, sql: string, values: D1Value[] = []) => db.prepare(sql).bind(...values).run();

export async function seedPostgresControl(db: D1Database, digest = "sha256:" + "a".repeat(64), limit = 2, source = postgresSource,
  concurrency: number | null = limit) {
  await pgRun(db, "INSERT INTO control_tenants VALUES('tenant-a','Synthetic A'),('tenant-b','Synthetic B')");
  await pgRun(db, `INSERT INTO control_memberships VALUES
    ('tenant-a','google:owner','owner',1),('tenant-a','google:reviewer','reviewer',1),
    ('tenant-a','google:reader','reader',1),('tenant-a','google:other-owner','owner',1),
    ('tenant-a','google:other-reader','reader',1),('tenant-b','google:owner','owner',1),('tenant-b','google:reader','reader',1)`);
  await pgRun(db, "INSERT INTO postgresql_read_budgets VALUES('tenant-a','budget',?)", [limit]);
  // Historical upgrade fixtures deliberately start before the optional resource migration.
  if (concurrency !== null && await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='postgresql_concurrency_limits'").bind().first()) {
    await pgRun(db, "INSERT INTO postgresql_concurrency_limits VALUES('tenant-a','budget',?)", [concurrency]);
  }
  await pgRun(db, `INSERT INTO postgresql_source_versions VALUES
    ('tenant-a','revision-1','orders','google:owner','fixture',?,?,'reader_a','budget','2099-01-01T00:00:00.000Z')`,
  [digest, canonicalControlJson(source)]);
  await pgRun(db, "INSERT INTO postgresql_source_heads VALUES('tenant-a','orders','revision-1',1)");
}

export async function publishPostgresFixture(db: D1Database, definition: unknown = postgresDefinition) {
  const owner = pgAccess(db, "owner");
  const r = await proposePostgresRevision(pgAccess(db, "reviewer"), { revisionId: "revision", provenanceRef: "synthetic:test", definition });
  const review = { revisionId: "revision", reviewedDigest: r.definitionDigest, evidenceRef: "synthetic:author-check-only" };
  await validatePostgresRevision(owner, review);
  await approvePostgresRevision(owner, { ...review, approvalId: "approval" });
  await promotePostgresRevision(owner, { revisionId: "revision", approvalId: "approval", releaseId: "release" });
}

export async function approvePostgresFixture(db: D1Database, requestId = "request", action: unknown = pgAction) {
  await requestPostgresRead(pgAccess(db), { requestId, releaseId: "release", action });
  return approvePostgresRead(pgAccess(db, "owner"), { requestId, releaseId: "release", sourceId: "revision-1",
    requesterId: "google:reader", reviewedAction: action });
}
