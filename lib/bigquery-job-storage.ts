import type { BigQueryEnv } from "./bigquery";
import { intentJobIdentity, observeIntentJob } from "./bigquery-job-recovery";
import { isEvidenceReceipt } from "./control-objects";
import type { ControlAccess } from "./control-storage";

type StoredJob = {
  delegation_audience?: string | null;
  action_digest: string; project_id: string; location: string; job_id: string; action_tag: string;
  receipt_id: string; contract_id: string; release_id: string; payload: string;
};

export async function readPreparedJob(access: ControlAccess, intentId: string) {
  // b.* includes the audience marker on v23+ without breaking pre-v23 reads.
  const row = await access.db.prepare(`SELECT b.*,
      i.action_digest,i.contract_id,c.release_id,r.payload
    FROM bigquery_job_bindings b
    JOIN execution_intents i ON i.tenant_id=b.tenant_id AND i.id=b.intent_id
    JOIN approval_contracts c ON c.tenant_id=i.tenant_id AND c.id=i.contract_id
    JOIN evidence_receipts r ON r.tenant_id=b.tenant_id AND r.id=b.receipt_id
    JOIN control_memberships m ON m.tenant_id=b.tenant_id
    WHERE b.tenant_id=? AND b.intent_id=? AND m.principal_id=? AND m.active=1 AND m.role='owner'`)
    .bind(access.tenantId, intentId, access.principalId).first<StoredJob>();
  if (!row) throw new Error("Prepared BigQuery job unavailable");
  if (row.delegation_audience != null) throw new Error("Delegated warehouse handoff disabled");
  const binding = { tenantId: access.tenantId, intentId, actionDigest: row.action_digest,
    projectId: row.project_id, location: row.location };
  const identity = await intentJobIdentity(binding);
  const receipt: unknown = JSON.parse(row.payload);
  if (row.job_id !== identity.jobReference.jobId || row.action_tag !== identity.labels.odap_action ||
      !isEvidenceReceipt(receipt) || receipt.id !== row.receipt_id || receipt.intentId !== intentId ||
      receipt.tenantId !== access.tenantId || receipt.outcome !== "pending" ||
      receipt.contractId !== row.contract_id || receipt.semanticReleaseId !== row.release_id) {
    throw new Error("Stored job binding or pending evidence is invalid");
  }
  return { binding, identity, receipt };
}

// Internal only. Target comes from trusted adapter configuration, not the API request.
// A prepared or replayed binding is never a grant to submit the job.
export async function prepareIntentJob(access: ControlAccess, intentId: string,
  env: Pick<BigQueryEnv, "BIGQUERY_PROJECT_ID" | "BIGQUERY_LOCATION">) {
  const projectId = env.BIGQUERY_PROJECT_ID;
  const location = env.BIGQUERY_LOCATION;
  if (!projectId?.trim() || !location?.trim()) throw new Error("Explicit BigQuery target required");
  const intent = await access.db.prepare(`SELECT i.action_digest FROM execution_intents i
    JOIN control_memberships m ON m.tenant_id=i.tenant_id
    WHERE i.tenant_id=? AND i.id=? AND m.principal_id=? AND m.active=1 AND m.role='owner'`)
    .bind(access.tenantId, intentId, access.principalId).first<{ action_digest: string }>();
  if (!intent) throw new Error("Execution intent unavailable");
  const { jobReference, labels } = await intentJobIdentity({ tenantId: access.tenantId, intentId,
    projectId, location, actionDigest: intent.action_digest });
  // The condition runs under the same write lock as the insert and receipt trigger.
  const result = await access.db.prepare(`INSERT INTO bigquery_job_bindings
    (tenant_id,intent_id,project_id,location,job_id,action_tag,receipt_id,prepared_by)
    SELECT ?,?,?,?,?,?,?,? WHERE NOT EXISTS (
      SELECT 1 FROM bigquery_job_bindings WHERE tenant_id=? AND intent_id=?)`)
    .bind(access.tenantId, intentId, projectId, location, jobReference.jobId, labels.odap_action,
      "pending_" + jobReference.jobId, access.principalId, access.tenantId, intentId).run();
  if (!result.success) throw new Error("Job preparation failed");
  const prepared = await readPreparedJob(access, intentId);
  if (prepared.binding.projectId !== projectId || prepared.binding.location !== location) {
    throw new Error("BigQuery target conflicts with prepared job");
  }
  return { identity: prepared.identity, receipt: prepared.receipt };
}

export async function observePreparedIntentJob(access: ControlAccess, intentId: string, env: BigQueryEnv) {
  const prepared = await readPreparedJob(access, intentId);
  return observeIntentJob(env, prepared.binding);
}
