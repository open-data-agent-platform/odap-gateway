import type { ControlAccess } from "./control-storage";
import { canonicalControlJson } from "./control-objects";
import { cancellationEvidenceMaxBytes, cancellationEvidenceProfile, cancellationEvidenceScope, verifyCancellationEvidence } from "./cancellation-evidence";
import { hasReceiptCreationEvent } from "./receipt-event-sql";

// One current-owner snapshot. No transport, outcome inference or historical attribution repair.
export async function exportCancellationEvidence(access: ControlAccess, audience: string, intentId: string) {
  if (![audience,intentId].every(v => typeof v === "string" && v.trim() && v.length <= 1024)) throw new Error("Invalid cancellation scope");
  const row = await access.db.prepare(`SELECT json_object('profile',?,'scope',?,
    'tenantId',j.tenant_id,'intentId',j.intent_id,'audience',j.audience,'contractId',j.contract_id,'actionDigest',j.action_digest,
    'job',json_object('projectId',j.project_id,'location',j.location,'jobId',j.job_id,'actionTag',j.action_tag,'pendingReceiptId',j.receipt_id),
    'claim',json_object('audience',h.delegation_audience,'bodyDigest',h.compiled_body_digest,
      'maximumBytesBilled',h.maximum_bytes_billed,'claimedBy',h.claimed_by,'claimedAt',h.claimed_at),
    'request',json_object('jobId',r.job_id,'audience',r.delegation_audience,'claimBodyDigest',r.claim_body_digest,
      'requestedBy',r.requested_by,'requestedAt',r.requested_at)) AS evidence
    FROM recoverable_delegated_jobs j JOIN dispatch_claims h ON h.tenant_id=j.tenant_id AND h.intent_id=j.intent_id
    JOIN bigquery_cancellation_requests r ON r.tenant_id=j.tenant_id AND r.intent_id=j.intent_id
      AND r.job_id=j.job_id AND r.delegation_audience=j.audience AND r.claim_body_digest=j.compiled_body_digest
    JOIN evidence_receipts p ON p.tenant_id=j.tenant_id AND p.id=j.receipt_id
    WHERE j.tenant_id=? AND j.intent_id=? AND j.audience=? AND j.operator_id=? AND ${hasReceiptCreationEvent("p")}`)
    .bind(cancellationEvidenceProfile,cancellationEvidenceScope,access.tenantId,intentId,audience,access.principalId)
    .first<{ evidence: string }>();
  if (!row) return null;
  if (typeof row.evidence !== "string" || row.evidence.length > cancellationEvidenceMaxBytes) throw new Error("Invalid cancellation evidence size");
  const json = canonicalControlJson(JSON.parse(row.evidence));
  const { digest } = await verifyCancellationEvidence(json, { tenantId: access.tenantId, intentId, audience });
  return { json, digest };
}
