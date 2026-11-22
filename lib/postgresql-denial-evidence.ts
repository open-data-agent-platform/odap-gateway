import { canonicalControlJson, isControlTimestamp, isEvidenceReceipt, sha256Text } from "./control-objects";

export const postgresDenialEvidenceProfile = "odap.gateway.local.postgresql-denial-evidence.v1";
export const postgresDenialEvidenceMaxBytes = 16384;
export const postgresDenialAttempt = /^pg-missing-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export type PostgresDenialEvidenceScope = { tenantId: string; attemptId: string };
const fields = (value: unknown, keys: string[]): value is Record<string, unknown> => !!value && typeof value === "object" &&
  Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 1024 &&
  value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
function invalid(): never { throw new Error("Invalid PostgreSQL denial evidence"); }

/** Verifies selected historical records and a pin, not issuer identity or actual non-execution. */
export async function verifyPostgresDenialEvidence(json: string, scope: PostgresDenialEvidenceScope, expectedDigest?: string) {
  if (typeof json !== "string" || json.length > postgresDenialEvidenceMaxBytes ||
      new TextEncoder().encode(json).length > postgresDenialEvidenceMaxBytes) invalid();
  const data: unknown = JSON.parse(json);
  if (!fields(data, ["profile", "tenantId", "attemptId", "denial", "receipt", "receiptCreatedAt", "creationEvent"]) ||
      data.profile !== postgresDenialEvidenceProfile ||
      !fields(data.denial, ["principalId", "agentId", "requestedRelease", "actionDigest", "recordedAt"]) ||
      !fields(data.creationEvent, ["actor", "recordedAt"]) || !isEvidenceReceipt(data.receipt)) invalid();
  if (!text(scope?.tenantId) || typeof scope?.attemptId !== "string" || !postgresDenialAttempt.test(scope.attemptId) ||
      data.tenantId !== scope.tenantId || data.attemptId !== scope.attemptId) throw new Error("Evidence scope mismatch");
  const { denial, receipt, creationEvent } = data;
  if (!text(denial.principalId) || denial.agentId !== "postgresql-session" || typeof denial.requestedRelease !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,127}$/.test(denial.requestedRelease) ||
      typeof denial.actionDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(denial.actionDigest) ||
      !isControlTimestamp(denial.recordedAt) || !isControlTimestamp(data.receiptCreatedAt) ||
      !isControlTimestamp(creationEvent.recordedAt) || creationEvent.actor !== denial.principalId ||
      creationEvent.recordedAt !== data.receiptCreatedAt || Date.parse(data.receiptCreatedAt as string) < Date.parse(denial.recordedAt as string) ||
      receipt.tenantId !== scope.tenantId || receipt.intentId !== scope.attemptId ||
      receipt.id !== "denied_preapproval_" + scope.attemptId || receipt.outcome !== "denied" ||
      receipt.contractId !== null || receipt.semanticReleaseId !== null || receipt.recordedAt !== denial.recordedAt ||
      receipt.reason !== "Requested semantic release not found in tenant; no approval issued") invalid();
  if (canonicalControlJson(data) !== json) invalid();
  const checksum = await sha256Text(json);
  if (expectedDigest !== undefined && checksum !== expectedDigest) throw new Error("Evidence checksum mismatch");
  return { consistent: true as const, recordedDecision: "denied" as const, digest: checksum,
    issuerAuthenticated: false as const, executionVerified: false as const, actionValuesVerified: false as const,
    authorizationGranted: false as const };
}
