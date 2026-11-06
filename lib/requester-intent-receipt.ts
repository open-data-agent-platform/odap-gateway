import { intentJobIdentity } from "./bigquery-job-identity";
import { isEvidenceReceipt } from "./control-objects";
import type { ControlAccess } from "./control-storage";
import { conflictingTerminalOutcomes } from "./delegated-evidence-sql";
import { summarizeReceipt } from "./receipt-summary";
import { hasReceiptCreationEvent } from "./receipt-event-sql";

type Row = {
  contractId: string; releaseId: string; delegationId: string; actionDigest: string;
  jobId: string | null; projectId: string; location: string; actionTag: string;
  pendingPayload: string | null; finalPayload: string | null;
  pendingLinked: number | null; claimLinked: number | null; observationsLinked: number;
  hasFinal: number; finalLinked: number | null; eventsLinked: number;
};

export async function readOwnIntentReceipt({ db, tenantId, principalId }: ControlAccess, audience: string, intentId: string) {
  // Follow the admission's job and settlement links in one snapshot. An arbitrary receipt naming this intent is not evidence.
  const r = await db.prepare(`SELECT a.contract_id AS contractId,c.release_id AS releaseId,u.delegation_id AS delegationId,
    i.action_digest AS actionDigest,j.job_id AS jobId,j.project_id AS projectId,j.location,j.action_tag AS actionTag,
    p.payload AS pendingPayload,f.payload AS finalPayload,
    ((p.id IS NULL OR ${hasReceiptCreationEvent("p")}) AND (f.id IS NULL OR ${hasReceiptCreationEvent("f")})) AS eventsLinked,
    (j.delegation_audience=a.audience AND j.receipt_id='pending_'||j.job_id AND j.prepared_reserved_units=i.reserved_units
      AND p.contract_id=c.id AND p.release_id=c.release_id AND p.created_by=j.prepared_by
      AND json_extract(p.payload,'$.recordedAt')=j.created_at) AS pendingLinked,
    (h.intent_id IS NULL OR (h.delegation_audience=a.audience AND h.compiled_body_digest IS NOT NULL
      AND h.maximum_bytes_billed=k.byte_cap AND k.byte_cap>0)) AS claimLinked,
    (NOT ${conflictingTerminalOutcomes} AND NOT EXISTS(SELECT 1 FROM bigquery_terminal_observations o WHERE o.tenant_id=a.tenant_id AND o.intent_id=a.intent_id AND
      (h.intent_id IS NULL OR o.delegation_audience IS NOT a.audience OR o.claim_body_digest IS NOT h.compiled_body_digest
       OR (f.id IS NOT NULL AND o.outcome IS NOT json_extract(f.payload,'$.outcome'))))) AS observationsLinked,
    (b.intent_id IS NOT NULL OR s.intent_id IS NOT NULL) AS hasFinal,
    (h.intent_id IS NOT NULL AND b.delegation_audience=a.audience AND b.claim_body_digest=h.compiled_body_digest
      AND b.attributed_project=j.project_id AND b.attributed_location=j.location AND b.receipt_id='final_'||j.job_id
      AND s.receipt_id=b.receipt_id AND s.actual_units=b.actual_micro_usd AND s.actor=b.actor
      AND f.created_by=b.actor AND f.contract_id=c.id AND f.release_id=c.release_id AND json_extract(f.payload,'$.recordedAt')=b.recorded_at
      AND EXISTS(SELECT 1 FROM bigquery_terminal_observations o WHERE o.tenant_id=a.tenant_id AND o.intent_id=a.intent_id
        AND o.outcome=json_extract(f.payload,'$.outcome'))) AS finalLinked
    FROM delegated_admissions a JOIN delegated_contract_issuances u USING(tenant_id,contract_id,requested_by,audience)
    JOIN execution_intents i ON i.tenant_id=a.tenant_id AND i.id=a.intent_id AND i.contract_id=a.contract_id
      AND i.principal_id=a.requested_by AND i.reservation_id=u.reservation_id
    JOIN approval_contracts c ON c.tenant_id=i.tenant_id AND c.id=i.contract_id
    JOIN control_memberships m ON m.tenant_id=a.tenant_id AND m.principal_id=a.requested_by
    LEFT JOIN bigquery_job_bindings j ON j.tenant_id=a.tenant_id AND j.intent_id=a.intent_id
    LEFT JOIN delegated_prepared_caps k ON k.tenant_id=a.tenant_id AND k.intent_id=a.intent_id
    LEFT JOIN evidence_receipts p ON p.tenant_id=a.tenant_id AND p.id=j.receipt_id
    LEFT JOIN dispatch_claims h ON h.tenant_id=a.tenant_id AND h.intent_id=a.intent_id
    LEFT JOIN bigquery_billing_evidence b ON b.tenant_id=a.tenant_id AND b.intent_id=a.intent_id
    LEFT JOIN cost_settlements s ON s.tenant_id=a.tenant_id AND s.intent_id=a.intent_id
    LEFT JOIN evidence_receipts f ON f.tenant_id=a.tenant_id AND f.id=s.receipt_id
    WHERE a.tenant_id=? AND a.intent_id=? AND a.audience=? AND a.requested_by=? AND m.active=1
      AND m.role IN ('reader','reviewer','owner')`).bind(tenantId,intentId,audience,principalId).first<Row>();
  if (!r) return null;
  const scope = { tenantId, intentId, contractId: r.contractId, delegationId: r.delegationId, actionDigest: r.actionDigest };
  if (r.eventsLinked !== 1 || r.claimLinked !== 1 || r.observationsLinked !== 1 || (r.hasFinal && r.finalLinked !== 1))
    throw new Error("Unverified receipt chain");
  if (r.jobId === null) return { ...scope, receipt: null };
  const identity = await intentJobIdentity({ ...scope, projectId: r.projectId, location: r.location });
  if (r.pendingLinked !== 1 || identity.jobReference.jobId !== r.jobId || identity.labels.odap_action !== r.actionTag)
    throw new Error("Invalid job binding");
  const parse = (payload: string | null, prefix: "pending" | "final") => {
    const v: unknown = payload && JSON.parse(payload);
    if (!isEvidenceReceipt(v) || v.tenantId !== tenantId || v.intentId !== intentId || v.contractId !== r.contractId ||
        v.semanticReleaseId !== r.releaseId || v.id !== prefix+"_"+r.jobId ||
        !(prefix === "pending" ? v.outcome === "pending" : ["succeeded","failed","cancelled"].includes(v.outcome)))
      throw new Error("Invalid linked receipt");
    return summarizeReceipt(v);
  };
  const pending = parse(r.pendingPayload, "pending");
  return { ...scope, receipt: r.hasFinal ? parse(r.finalPayload, "final") : pending };
}
