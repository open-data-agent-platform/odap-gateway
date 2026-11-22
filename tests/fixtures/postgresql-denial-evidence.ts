import { canonicalControlJson } from "../../lib/control-objects";
import { postgresDenialEvidenceProfile } from "../../lib/postgresql-denial-evidence";

export const postgresDenialScope = { tenantId: "tenant-a", attemptId: "pg-missing-12345678-1234-4234-8234-123456789abc" };
export function syntheticPostgresDenial() {
  const recordedAt = "2026-01-01T00:00:00.000Z";
  return { profile: postgresDenialEvidenceProfile, ...postgresDenialScope,
    denial: { principalId: "google:reader", agentId: "postgresql-session", requestedRelease: "missing",
      actionDigest: "sha256:" + "a".repeat(64), recordedAt },
    receipt: { schemaVersion: "0.1", id: "denied_preapproval_" + postgresDenialScope.attemptId,
      tenantId: "tenant-a", intentId: postgresDenialScope.attemptId, contractId: null, semanticReleaseId: null,
      outcome: "denied", reason: "Requested semantic release not found in tenant; no approval issued", recordedAt },
    receiptCreatedAt: recordedAt, creationEvent: { actor: "google:reader", recordedAt } };
}
export const syntheticPostgresDenialJson = () => canonicalControlJson(syntheticPostgresDenial());
