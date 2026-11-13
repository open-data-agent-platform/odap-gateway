import { canonicalControlJson, isControlTimestamp, sha256Text } from "./control-objects";
import { intentJobIdentity } from "./bigquery-job-identity";

export const cancellationEvidenceProfile = "odap.gateway.local.delegated-cancellation-request.v1";
export const cancellationEvidenceScope = "recorded-request-only";
export const cancellationEvidenceMaxBytes = 64 * 1024;
export type CancellationEvidenceScope = { tenantId: string; intentId: string; audience: string };

function fields(value: unknown, keys: string): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const names = keys.split(" ");
  return Object.keys(value).length === names.length && names.every(key => Object.hasOwn(value, key));
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 1024 && !/[\u0000-\u001f\u007f]/.test(value);
}
function digest(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

// A consistent local request is not an authenticated issuer or a warehouse outcome.
export async function verifyCancellationEvidence(json: string, scope: CancellationEvidenceScope, expectedDigest?: string) {
  if (typeof json !== "string" || json.length > cancellationEvidenceMaxBytes ||
      new TextEncoder().encode(json).length > cancellationEvidenceMaxBytes) throw new Error("Invalid cancellation evidence size");
  const data: unknown = JSON.parse(json);
  if (!fields(data, "profile scope tenantId intentId audience contractId actionDigest job claim request") ||
      data.profile !== cancellationEvidenceProfile || data.scope !== cancellationEvidenceScope ||
      !fields(data.job, "projectId location jobId actionTag pendingReceiptId") ||
      !fields(data.claim, "audience bodyDigest maximumBytesBilled claimedBy claimedAt") ||
      !fields(data.request, "jobId audience claimBodyDigest requestedBy requestedAt")) throw new Error("Invalid cancellation evidence profile");
  const { job, claim, request } = data;
  if (![data.tenantId,data.intentId,data.audience,data.contractId,claim.claimedBy,request.requestedBy].every(text) ||
      !digest(data.actionDigest) || !digest(claim.bodyDigest) ||
      typeof job.projectId !== "string" || !/^[a-z][a-z0-9:.-]{4,127}$/i.test(job.projectId) ||
      typeof job.location !== "string" || !/^[a-z0-9-]{1,64}$/i.test(job.location) ||
      typeof claim.maximumBytesBilled !== "number" || !Number.isSafeInteger(claim.maximumBytesBilled) || claim.maximumBytesBilled <= 0 ||
      !isControlTimestamp(claim.claimedAt) || !isControlTimestamp(request.requestedAt)) throw new Error("Invalid cancellation records");
  if (![scope.tenantId,scope.intentId,scope.audience].every(text) || data.tenantId !== scope.tenantId ||
      data.intentId !== scope.intentId || data.audience !== scope.audience) throw new Error("Evidence scope mismatch");
  const identity = await intentJobIdentity({ tenantId: scope.tenantId, intentId: scope.intentId,
    actionDigest: data.actionDigest, projectId: job.projectId, location: job.location });
  if (job.jobId !== identity.jobReference.jobId || job.actionTag !== identity.labels.odap_action ||
      job.pendingReceiptId !== "pending_" + job.jobId || request.jobId !== job.jobId ||
      claim.audience !== data.audience || request.audience !== data.audience || request.claimBodyDigest !== claim.bodyDigest)
    throw new Error("Cancellation attribution mismatch");
  if (Date.parse(request.requestedAt as string) < Date.parse(claim.claimedAt as string)) throw new Error("Invalid cancellation chronology");
  if (canonicalControlJson(data) !== json) throw new Error("Noncanonical evidence JSON");
  const checksum = await sha256Text(json);
  if (expectedDigest !== undefined && checksum !== expectedDigest) throw new Error("Evidence checksum mismatch");
  return { consistent: true as const, issuerAuthenticated: false as const, cancellationConfirmed: false as const,
    scope: cancellationEvidenceScope, digest: checksum };
}
