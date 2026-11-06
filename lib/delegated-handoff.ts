import { bigQueryByteCeiling } from "./bigquery-byte-ceiling";
import { intentJobIdentity } from "./bigquery-job-identity";
import { canonicalControlJson, isApprovalContract, isEvidenceReceipt, isSemanticRelease, sha256Text } from "./control-objects";
import type { ControlAccess } from "./control-storage";
import { bindMetricRead, type MetricRead } from "./dispatch-authority";
import { compileReleasedMetric } from "./metric-compiler";

type Terms = {
  contract_payload: string; release_payload: string; receipt_payload: string; definition_json: string;
  project_id: string; location: string; job_id: string; action_tag: string; receipt_id: string;
  reserved_units: number; micro_usd_per_tib: number; max_job_bytes: number; byte_cap: number;
};
const scope = "tenant_id=? AND intent_id=? AND operator_id=? AND audience=? AND principal_id=? AND agent_id=? AND action_digest=?";

// Internal only. No default sender, HTTP route, credential source, or retry.
export async function handoffDelegatedRead(access: ControlAccess, intentId: string,
  subject: { audience: string; principalId: string; agentId: string }, action: MetricRead,
  sendOnce: (canonicalJob: string) => Promise<void>) {
  if (typeof sendOnce !== "function") throw new Error("Explicit handoff sender required");
  const { db, tenantId, principalId: operator } = access;
  const { audience, principalId, agentId } = subject;
  const { canonicalAction, actionDigest } = await bindMetricRead(action);
  const args = [tenantId,intentId,operator,audience,principalId,agentId,actionDigest];
  const row = await db.prepare(`SELECT contract_payload,release_payload,receipt_payload,definition_json,
    project_id,location,job_id,action_tag,receipt_id,reserved_units,micro_usd_per_tib,max_job_bytes,byte_cap
    FROM claimable_delegated_reads WHERE ${scope}`).bind(...args).first<Terms>();
  if (!row) throw new Error("Delegated handoff unavailable");

  const contract: unknown = JSON.parse(row.contract_payload), release: unknown = JSON.parse(row.release_payload);
  const receipt: unknown = JSON.parse(row.receipt_payload);
  if (!isApprovalContract(contract) || !isSemanticRelease(release) || !isEvidenceReceipt(receipt) ||
      contract.tenantId !== tenantId || release.tenantId !== tenantId || receipt.tenantId !== tenantId ||
      contract.id !== receipt.contractId || release.id !== receipt.semanticReleaseId || contract.semanticReleaseId !== release.id ||
      contract.actionDigest !== actionDigest || contract.agentId !== agentId || contract.principalId !== principalId ||
      receipt.id !== row.receipt_id || receipt.intentId !== intentId || receipt.outcome !== "pending") throw new Error("Invalid handoff evidence");
  const { jobReference, labels } = await intentJobIdentity({ tenantId,intentId,actionDigest,projectId: row.project_id,location: row.location });
  const cap = bigQueryByteCeiling(row.reserved_units,row.micro_usd_per_tib,row.max_job_bytes);
  if (jobReference.jobId !== row.job_id || labels.odap_action !== row.action_tag || row.receipt_id !== "pending_"+row.job_id ||
      cap !== row.byte_cap) throw new Error("Invalid prepared handoff binding");
  const compiled = await compileReleasedMetric(release,row.definition_json,canonicalAction,row.project_id);
  const body = canonicalControlJson({ jobReference, configuration: { labels, query: { ...compiled, maximumBytesBilled: String(cap) } } });
  const digest = await sha256Text(body);

  // Claim after compilation. Only confirmed insertion of this exact snapshot
  // permits even one sender call; an ambiguous database response never does.
  const claim = await db.prepare(`INSERT INTO dispatch_claims
    (tenant_id,intent_id,claimed_by,maximum_bytes_billed,delegation_audience,compiled_body_digest)
    SELECT tenant_id,intent_id,operator_id,byte_cap,audience,? FROM claimable_delegated_reads WHERE ${scope}
    AND job_id=? AND action_tag=? AND receipt_id=? AND project_id=? AND location=? AND byte_cap=?
    AND contract_payload=? AND release_payload=? AND receipt_payload=? AND definition_json=?
    AND reserved_units=? AND micro_usd_per_tib=? AND max_job_bytes=?
    RETURNING compiled_body_digest AS digest`).bind(digest,...args,row.job_id,row.action_tag,row.receipt_id,row.project_id,
      row.location,cap,row.contract_payload,row.release_payload,row.receipt_payload,row.definition_json,row.reserved_units,
      row.micro_usd_per_tib,row.max_job_bytes).first<{ digest: string }>();
  if (claim?.digest !== digest) throw new Error("Delegated handoff not confirmed");
  try {
    await sendOnce(body);
    return { state: "handed-off" as const, jobReference, receiptId: receipt.id };
  } catch {
    return { state: "observation-required" as const, jobReference, receiptId: receipt.id };
  }
}
