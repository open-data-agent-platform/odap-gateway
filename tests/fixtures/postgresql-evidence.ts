import { canonicalControlJson } from "../../lib/control-objects";
import { compilePostgresMetric } from "../../lib/postgresql-metric-compiler";
import { postgresEvidenceProfile } from "../../lib/postgresql-evidence";
import { postgresRead } from "./postgresql";

export const postgresEvidenceScope = { tenantId: "tenant-a", requestId: "request", intentId: "intent" };
export async function syntheticPostgresEvidence() {
  const read = await postgresRead();
  const compiled = await compilePostgresMetric(read.release, read.definitionJson, read.canonicalAction, read.source);
  const at = "2026-01-01T00:00:00.000Z";
  return { profile: postgresEvidenceProfile, ...postgresEvidenceScope, monetaryCost: "unpriced",
    release: read.release, definition: JSON.parse(read.definitionJson), action: JSON.parse(read.canonicalAction),
    source: { id: "revision-1", target: "orders", ownerId: read.release.owner, connectionDigest: "sha256:" + "a".repeat(64),
      roleName: "reader_a", relation: read.source },
    contract: { schemaVersion: "0.1", id: "contract", tenantId: "tenant-a", semanticReleaseId: read.release.id,
      principalId: "fixture-reader", agentId: "postgresql-session", actionDigest: compiled.actionDigest,
      policyRevision: "revision-1", sourceRevision: "revision-1", target: "orders", actionType: "data.read",
      authority: { mode: "human", reference: "request" }, reservationId: "contract", expiresAt: "2026-01-01T00:10:00.000Z", state: "authorized" },
    claim: { principalId: "fixture-reader", budgetId: "budget", statementDigest: compiled.statementDigest, claimedAt: at },
    observation: null, failure: null, cancellation: null,
    receipts: [{ schemaVersion: "0.1", id: "pg-pending-intent", tenantId: "tenant-a", intentId: "intent",
      contractId: "contract", semanticReleaseId: read.release.id, outcome: "pending",
      reason: "postgresql_claimed_observation_required", recordedAt: at }] };
}
export async function syntheticPostgresEvidenceJson() { return canonicalControlJson(await syntheticPostgresEvidence()); }
