import { intentJobIdentity } from "../../lib/bigquery-job-identity";
import { cancellationEvidenceProfile, cancellationEvidenceScope } from "../../lib/cancellation-evidence";

export async function syntheticCancellationEvidence() {
  const actionDigest="sha256:"+"a".repeat(64),bodyDigest="sha256:"+"b".repeat(64);
  const identity=await intentJobIdentity({ tenantId:"t",intentId:"i",actionDigest,projectId:"demo-project",location:"US" });
  return { profile:cancellationEvidenceProfile,scope:cancellationEvidenceScope,tenantId:"t",intentId:"i",audience:"fixture",
    contractId:"c",actionDigest,
    job:{ ...identity.jobReference,actionTag:identity.labels.odap_action,pendingReceiptId:"pending_"+identity.jobReference.jobId },
    claim:{ audience:"fixture",bodyDigest,maximumBytesBilled:100,claimedBy:"original-owner",claimedAt:"2026-01-01T00:00:00.000Z" },
    request:{ jobId:identity.jobReference.jobId,audience:"fixture",claimBodyDigest:bodyDigest,
      requestedBy:"later-owner",requestedAt:"2026-01-01T00:00:01.000Z" } };
}
