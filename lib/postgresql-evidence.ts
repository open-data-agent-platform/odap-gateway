import { canonicalControlJson, isApprovalContract, isControlTimestamp, isEvidenceReceipt, isSemanticRelease, sha256Text } from "./control-objects";
import { compilePostgresMetric, type PostgresSource } from "./postgresql-metric-compiler";

export const postgresEvidenceProfile = "odap.gateway.local.postgresql-read-evidence.v1";
export const postgresEvidenceMaxBytes = 262144;
export type PostgresEvidenceScope = { tenantId: string; requestId: string; intentId: string };
const fields = (value: unknown, names: string): value is Record<string, unknown> => {
  const keys = names.split(" ");
  return !!value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
};
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 1024 &&
  value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
const digest = (value: unknown): value is string => typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
function invalid(): never { throw new Error("Invalid PostgreSQL evidence"); }

/** Checks local record consistency, not issuer identity, Agent signatures or provider truth. */
export async function verifyPostgresEvidence(json: string, scope: PostgresEvidenceScope, expectedDigest?: string) {
  if (typeof json !== "string" || json.length > postgresEvidenceMaxBytes ||
      new TextEncoder().encode(json).length > postgresEvidenceMaxBytes) invalid();
  const data: unknown = JSON.parse(json);
  if (!fields(data, "profile tenantId requestId intentId monetaryCost release contract definition action source claim observation failure cancellation receipts") ||
      data.profile !== postgresEvidenceProfile || data.monetaryCost !== "unpriced" ||
      !isSemanticRelease(data.release) || !isApprovalContract(data.contract) ||
      !fields(data.source, "id target ownerId connectionDigest roleName relation") ||
      !fields(data.source.relation, "database schema table tenantColumn") ||
      !fields(data.claim, "principalId budgetId statementDigest claimedAt") ||
      !Array.isArray(data.receipts) || data.receipts.length < 1 || data.receipts.length > 4) invalid();
  const { release, contract, source, claim } = data;
  if (![scope?.tenantId, scope?.requestId, scope?.intentId, source.id, source.target, source.ownerId,
    source.roleName, claim.principalId, claim.budgetId].every(text) ||
      data.tenantId !== scope.tenantId || data.requestId !== scope.requestId || data.intentId !== scope.intentId) {
    throw new Error("Evidence scope mismatch");
  }
  if (release.tenantId !== scope.tenantId || contract.tenantId !== scope.tenantId || release.state !== "released" ||
      contract.state !== "authorized" || contract.semanticReleaseId !== release.id || release.sourceRevision !== source.id ||
      release.owner !== source.ownerId || contract.sourceRevision !== source.id || contract.policyRevision !== source.id ||
      contract.target !== source.target || contract.principalId !== claim.principalId || contract.reservationId !== contract.id ||
      contract.authority.mode !== "human" || contract.authority.reference !== scope.requestId ||
      !digest(source.connectionDigest) || !digest(claim.statementDigest) || !isControlTimestamp(claim.claimedAt) ||
      Date.parse(claim.claimedAt as string) >= Date.parse(contract.expiresAt)) invalid();
  const compiled = await compilePostgresMetric(release, canonicalControlJson(data.definition), canonicalControlJson(data.action),
    source.relation as PostgresSource);
  if (compiled.statementDigest !== claim.statementDigest || compiled.actionDigest !== contract.actionDigest ||
      (data.action as Record<string, unknown>).target !== source.target) invalid();

  const expected = new Map<string, { outcome: string; reason: string; at?: string }>([
    ["pg-pending-" + scope.intentId, { outcome: "pending", reason: "postgresql_claimed_observation_required" }],
  ]);
  const afterClaim = (at: unknown): at is string => isControlTimestamp(at) && Date.parse(at as string) >= Date.parse(claim.claimedAt as string);
  let state = "observation-required", terminalAt: string | undefined;
  if (data.observation !== null) {
    if (!fields(data.observation, "outcome recordedAt") ||
        !["succeeded", "observation-required"].includes(data.observation.outcome as string) || !afterClaim(data.observation.recordedAt)) invalid();
    state = data.observation.outcome as string;
    if (state === "succeeded") terminalAt = data.observation.recordedAt;
    expected.set("pg-observed-" + scope.intentId, { outcome: state === "succeeded" ? "succeeded" : "pending",
      reason: state === "succeeded" ? "postgresql_read_acknowledged" : "postgresql_execution_unconfirmed", at: data.observation.recordedAt });
  }
  if (data.failure !== null) {
    if (!fields(data.failure, "sqlState statementDigest recordedAt") || !["57014", "42501"].includes(data.failure.sqlState as string) ||
        data.failure.statementDigest !== claim.statementDigest || !afterClaim(data.failure.recordedAt) || terminalAt ||
        (data.observation !== null && Date.parse(data.failure.recordedAt) < Date.parse((data.observation as Record<string, string>).recordedAt))) invalid();
    state = "failed"; terminalAt = data.failure.recordedAt;
    expected.set("pg-failed-" + scope.intentId, { outcome: "failed", at: data.failure.recordedAt,
      reason: data.failure.sqlState === "57014" ? "postgresql_query_canceled_acknowledged" : "postgresql_permission_denied_acknowledged" });
  }
  if (data.cancellation !== null) {
    if (!fields(data.cancellation, "requestedBy recordedAt") || !text(data.cancellation.requestedBy) || !afterClaim(data.cancellation.recordedAt) ||
        ![claim.principalId, source.ownerId].includes(data.cancellation.requestedBy) ||
        (terminalAt && Date.parse(data.cancellation.recordedAt) > Date.parse(terminalAt))) invalid();
    expected.set("pg-cancel-" + scope.intentId, { outcome: "pending", reason: "postgresql_cancellation_requested", at: data.cancellation.recordedAt });
  }
  if (data.receipts.length !== expected.size) invalid();
  const seen = new Set<string>();
  let pendingAt: string | undefined;
  for (const receipt of data.receipts) {
    if (!isEvidenceReceipt(receipt)) invalid();
    const match = expected.get(receipt.id);
    if (!match || seen.has(receipt.id) || receipt.tenantId !== scope.tenantId || receipt.intentId !== scope.intentId ||
        receipt.contractId !== contract.id || receipt.semanticReleaseId !== release.id || receipt.outcome !== match.outcome ||
        receipt.reason !== match.reason || !afterClaim(receipt.recordedAt) || (match.at && receipt.recordedAt !== match.at)) invalid();
    seen.add(receipt.id);
    if (receipt.id === "pg-pending-" + scope.intentId) pendingAt = receipt.recordedAt;
  }
  if (!pendingAt || data.receipts.some(receipt => Date.parse(receipt.recordedAt) < Date.parse(pendingAt!))) invalid();
  if (canonicalControlJson(data) !== json) invalid();
  const checksum = await sha256Text(json);
  if (expectedDigest !== undefined && checksum !== expectedDigest) throw new Error("Evidence checksum mismatch");
  return { consistent: true as const, issuerAuthenticated: false as const, agentSignatureVerified: false as const,
    providerVerified: false as const, authorizationGranted: false as const, monetaryCost: "unpriced" as const,
    state, cancellationConfirmed: false as const, digest: checksum };
}
