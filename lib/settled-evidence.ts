import { intentJobIdentity } from "./bigquery-job-identity";
import { canonicalControlJson, isApprovalContract, isControlTimestamp, isEvidenceReceipt, isSemanticRelease, sha256Text } from "./control-objects";

export const settledEvidenceProfile = "odap.gateway.local.settled-bigquery.v1";
export const delegatedSettledEvidenceProfile = "odap.gateway.local.settled-delegated-bigquery.v1";
type Scope = { tenantId: string; intentId: string; audience?: string };

function fields(v: unknown, keys: string): v is Record<string, unknown> {
  if (!v || typeof v !== "object" || Object.getPrototypeOf(v) !== Object.prototype) return false;
  const names = keys.split(" ");
  return Object.keys(v).length === names.length && names.every(k => Object.hasOwn(v, k));
}
function natural(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && !Object.is(v, -0);
}
function scoped(row: Record<string, unknown>, scope: Scope) {
  return row.tenantId === scope.tenantId && row.intentId === scope.intentId;
}

// Checks a detached local snapshot, not its issuer or current authorization.
export async function verifySettledEvidence(json: string, scope: Scope, expectedDigest?: string) {
  const data: unknown = JSON.parse(json);
  const common = "profile release contract intent job pending observation final bill settlement";
  const delegated = fields(data, common + " delegation") && data.profile === delegatedSettledEvidenceProfile;
  if (!delegated && !(fields(data, common) && data.profile === settledEvidenceProfile))
    throw new Error("Invalid settled evidence profile");
  const { release, contract, intent, job, pending, observation, final, bill, settlement } = data;
  if (!isSemanticRelease(release) || !isApprovalContract(contract) ||
      !isEvidenceReceipt(pending) || !isEvidenceReceipt(final) ||
      !fields(intent, "tenantId intentId contractId principalId reservationId actionDigest") ||
      !fields(job, "tenantId intentId projectId location jobId actionTag pendingReceiptId maximumBytesBilled claimedBy claimedAt") ||
      !fields(observation, "tenantId intentId outcome billedBytes observedBy observedAt") ||
      !fields(bill, "tenantId intentId receiptId reference actualMicroUsd recordedAt actor") ||
      !fields(settlement, "tenantId intentId receiptId actualMicroUsd actor")) throw new Error("Invalid evidence records");
  let delegation;
  if (delegated) {
    const pin = data.delegation;
    if (!fields(pin, "admissionAudience claimAudience claimDigest observedAudience observedDigest billedAudience billedDigest billedProject billedLocation") ||
        typeof pin.claimAudience !== "string" || !pin.claimAudience.trim() ||
        typeof pin.claimDigest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(pin.claimDigest) ||
        ![pin.admissionAudience,pin.observedAudience,pin.billedAudience].every(v => v === pin.claimAudience) ||
        pin.claimDigest !== pin.observedDigest || pin.claimDigest !== pin.billedDigest ||
        pin.billedProject !== job.projectId || pin.billedLocation !== job.location)
      throw new Error("Delegated attribution mismatch");
    delegation = { audience: pin.claimAudience, claimDigest: pin.claimDigest };
  }
  if ((scope.audience !== undefined && scope.audience !== delegation?.audience) ||
      release.tenantId !== scope.tenantId || contract.tenantId !== scope.tenantId ||
      ![intent, job, observation, pending, final, bill, settlement].every(r => scoped(r, scope))) {
    throw new Error("Evidence scope mismatch");
  }
  if (release.state !== "released" || contract.state !== "authorized" ||
      !/^sha256:[0-9a-f]{64}$/.test(release.definitionDigest) || !/^sha256:[0-9a-f]{64}$/.test(contract.actionDigest) ||
      contract.semanticReleaseId !== release.id || contract.sourceRevision !== release.sourceRevision ||
      contract.id !== intent.contractId || contract.principalId !== intent.principalId ||
      contract.reservationId !== intent.reservationId || contract.actionDigest !== intent.actionDigest ||
      ![pending, final].every(r => r.contractId === contract.id && r.semanticReleaseId === release.id)) {
    throw new Error("Release or approval link mismatch");
  }
  if (typeof job.projectId !== "string" || typeof job.location !== "string" ||
      !natural(job.maximumBytesBilled) || job.maximumBytesBilled === 0) throw new Error("Invalid bounded job");
  if (![job.claimedBy, observation.observedBy, bill.actor].every(v => typeof v === "string" && v.trim()) ||
      !isControlTimestamp(job.claimedAt) || !isControlTimestamp(observation.observedAt) ||
      bill.actor !== settlement.actor) throw new Error("Invalid evidence attribution");
  const identity = await intentJobIdentity({ tenantId: scope.tenantId, intentId: scope.intentId,
    projectId: job.projectId, location: job.location, actionDigest: contract.actionDigest });
  if (job.jobId !== identity.jobReference.jobId || job.actionTag !== identity.labels.odap_action ||
      pending.id !== "pending_" + job.jobId || job.pendingReceiptId !== pending.id || pending.outcome !== "pending" ||
      final.id !== "final_" + job.jobId) throw new Error("Job or receipt link mismatch");
  if (!["succeeded", "failed", "cancelled"].includes(final.outcome) || final.outcome !== observation.outcome ||
      (observation.billedBytes !== null && !natural(observation.billedBytes))) throw new Error("Terminal observation mismatch");
  if (bill.receiptId !== final.id || settlement.receiptId !== final.id || bill.recordedAt !== final.recordedAt ||
      typeof bill.reference !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,127}$/.test(bill.reference) ||
      !natural(bill.actualMicroUsd) || settlement.actualMicroUsd !== bill.actualMicroUsd) throw new Error("Billing link mismatch");
  if (canonicalControlJson(data) !== json) throw new Error("Noncanonical evidence JSON");
  const digest = await sha256Text(json);
  if (expectedDigest !== undefined && digest !== expectedDigest) throw new Error("Evidence checksum mismatch");
  return { consistent: true as const, issuerAuthenticated: false as const, digest,
    receiptId: final.id, outcome: final.outcome, actualMicroUsd: bill.actualMicroUsd, ...(delegation && { delegation }) };
}
