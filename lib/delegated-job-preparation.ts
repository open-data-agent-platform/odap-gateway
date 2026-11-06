import { bigQueryByteCeiling } from "./bigquery-byte-ceiling";
import { intentJobIdentity } from "./bigquery-job-identity";
import type { ControlAccess } from "./control-storage";

type Terms = { action_digest: string; project_id: string; location: string;
  reserved_units: number; micro_usd_per_tib: number; max_job_bytes: number };
const scope = "j.tenant_id=? AND j.intent_id=? AND j.audience=? AND j.operator_id=?";
const unchanged = "j.action_digest=? AND j.project_id=? AND j.location=? AND j.reserved_units=? AND j.micro_usd_per_tib=? AND j.max_job_bytes=?";

export async function prepareDelegatedJob(access: ControlAccess, audience: string, intentId: string) {
  const { db, tenantId, principalId } = access;
  const actor = [tenantId, intentId, audience, principalId];
  const terms = await db.prepare(`SELECT action_digest,project_id,location,reserved_units,micro_usd_per_tib,max_job_bytes
    FROM preparable_delegated_jobs j WHERE ${scope}`).bind(...actor).first<Terms>();
  if (!terms) return null;
  const { jobReference, labels } = await intentJobIdentity({ tenantId, intentId, actionDigest: terms.action_digest,
    projectId: terms.project_id, location: terms.location });
  const receiptId = "pending_" + jobReference.jobId;
  const maximumBytesBilled = String(bigQueryByteCeiling(terms.reserved_units, terms.micro_usd_per_tib, terms.max_job_bytes));
  const args = [...actor, terms.action_digest, terms.project_id, terms.location, terms.reserved_units,
    terms.micro_usd_per_tib, terms.max_job_bytes];
  const created = await db.prepare(`INSERT INTO bigquery_job_bindings
    (tenant_id,intent_id,project_id,location,job_id,action_tag,receipt_id,prepared_by,delegation_audience,
      prepared_reserved_units,prepared_rate,prepared_byte_limit)
    SELECT j.tenant_id,j.intent_id,j.project_id,j.location,?,?,?,j.operator_id,j.audience,j.reserved_units,
      j.micro_usd_per_tib,j.max_job_bytes FROM preparable_delegated_jobs j WHERE ${scope} AND ${unchanged}
      AND NOT EXISTS(SELECT 1 FROM bigquery_job_bindings b WHERE b.tenant_id=j.tenant_id AND b.intent_id=j.intent_id)
    RETURNING job_id`).bind(jobReference.jobId, labels.odap_action, receiptId, ...args).first();
  if (!created) {
    const prior = await db.prepare(`SELECT b.job_id FROM preparable_delegated_jobs j JOIN bigquery_job_bindings b
      ON b.tenant_id=j.tenant_id AND b.intent_id=j.intent_id AND b.delegation_audience=j.audience
        AND b.project_id=j.project_id AND b.location=j.location AND b.prepared_reserved_units=j.reserved_units
        AND b.prepared_rate=j.micro_usd_per_tib AND b.prepared_byte_limit=j.max_job_bytes
      WHERE ${scope} AND ${unchanged} AND b.job_id=? AND b.action_tag=? AND b.receipt_id=?`)
      .bind(...args, jobReference.jobId, labels.odap_action, receiptId).first();
    if (!prior) return null;
  }
  return { preparation: { intentId, jobReference, receiptId, maximumBytesBilled }, replay: !created };
}
