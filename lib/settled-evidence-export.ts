import type { ControlAccess } from "./control-storage";
import { canonicalControlJson } from "./control-objects";
import { conflictingTerminalOutcomes, delegatedBillLink, delegatedEvidenceJoins, nonDelegatedEvidence } from "./delegated-evidence-sql";
import { delegatedSettledEvidenceProfile, settledEvidenceProfile, verifySettledEvidence } from "./settled-evidence";
import { hasReceiptCreationEvent } from "./receipt-event-sql";

// A single owner-scoped SELECT gives one snapshot, without billing or warehouse access.
export async function exportSettledEvidence(access: ControlAccess, intentId: string, audience?: string) {
  const row = await access.db.prepare(`SELECT json_object('profile',?,
      'release',json(r.payload),'contract',json(c.payload),'pending',json(p.payload),'final',json(f.payload),
      'intent',json_object('tenantId',i.tenant_id,'intentId',i.id,'contractId',i.contract_id,
        'principalId',i.principal_id,'actionDigest',i.action_digest,'reservationId',i.reservation_id),
      'job',json_object('tenantId',j.tenant_id,'intentId',j.intent_id,'jobId',j.job_id,'actionTag',j.action_tag,
        'projectId',j.project_id,'location',j.location,'pendingReceiptId',j.receipt_id,'maximumBytesBilled',d.maximum_bytes_billed,
        'claimedAt',d.claimed_at,'claimedBy',d.claimed_by),
      'observation',json_object('tenantId',o.tenant_id,'intentId',o.intent_id,'outcome',o.outcome,'billedBytes',o.billed_bytes,
        'observedAt',o.observed_at,'observedBy',o.observed_by),
      'bill',json_object('tenantId',b.tenant_id,'intentId',b.intent_id,'reference',b.evidence_ref,
        'receiptId',b.receipt_id,'actualMicroUsd',b.actual_micro_usd,'recordedAt',b.recorded_at,'actor',b.actor),
      'settlement',json_object('tenantId',s.tenant_id,'intentId',s.intent_id,'receiptId',s.receipt_id,
        'actualMicroUsd',s.actual_units,'actor',s.actor)
    ) AS evidence, CASE WHEN a.intent_id IS NOT NULL THEN json_object(
      'admissionAudience',a.audience,'claimAudience',d.delegation_audience,'claimDigest',d.compiled_body_digest,
      'observedAudience',o.delegation_audience,'observedDigest',o.claim_body_digest,
      'billedAudience',b.delegation_audience,'billedDigest',b.claim_body_digest,
      'billedProject',b.attributed_project,'billedLocation',b.attributed_location) END AS delegation
    FROM execution_intents i
    JOIN approval_contracts c ON c.tenant_id=i.tenant_id AND c.id=i.contract_id
    JOIN semantic_releases r ON r.tenant_id=i.tenant_id AND r.id=c.release_id
    JOIN bigquery_job_bindings j ON j.tenant_id=i.tenant_id AND j.intent_id=i.id
    JOIN dispatch_claims d ON d.tenant_id=i.tenant_id AND d.intent_id=i.id AND d.maximum_bytes_billed IS NOT NULL
    JOIN evidence_receipts p ON p.tenant_id=i.tenant_id AND p.id=j.receipt_id
    JOIN bigquery_terminal_observations o ON o.tenant_id=i.tenant_id AND o.intent_id=i.id
    JOIN bigquery_billing_evidence b ON b.tenant_id=i.tenant_id AND b.intent_id=i.id
    JOIN cost_settlements s ON s.tenant_id=i.tenant_id AND s.intent_id=i.id
    JOIN evidence_receipts f ON f.tenant_id=i.tenant_id AND f.id=s.receipt_id
    JOIN control_memberships m ON m.tenant_id=i.tenant_id
    ${delegatedEvidenceJoins}
    WHERE i.tenant_id=? AND i.id=? AND m.principal_id=? AND m.active=1 AND m.role='owner'
      AND NOT ${conflictingTerminalOutcomes}
      AND ${hasReceiptCreationEvent("p")} AND ${hasReceiptCreationEvent("f")}
      AND (? IS NULL OR a.audience=?) AND (${nonDelegatedEvidence} OR ${delegatedBillLink})
    ORDER BY o.has_bytes ASC LIMIT 1`)
    .bind(settledEvidenceProfile, access.tenantId, intentId, access.principalId, audience ?? null, audience ?? null)
    .first<{ evidence: string; delegation: string | null }>();
  if (!row) return null;
  const data = JSON.parse(row.evidence);
  if (row.delegation !== null) {
    data.profile = delegatedSettledEvidenceProfile;
    data.delegation = JSON.parse(row.delegation);
  }
  const json = canonicalControlJson(data);
  const { digest } = await verifySettledEvidence(json, { tenantId: access.tenantId, intentId, audience });
  return { json, digest };
}
