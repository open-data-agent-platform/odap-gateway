import type { ControlAccess } from "./control-storage";
import { hasReceiptCreationEvent } from "./receipt-event-sql";
import { conflictingTerminalOutcomes, delegatedBillLink, delegatedEvidenceJoins, delegatedObservationLink, nonDelegatedEvidence } from "./delegated-evidence-sql";

type CoverageCounts = {
  missingReleaseRefusals: number;
  admitted: number;
  pendingOutcome: number;
  pendingBilling: number;
  attributedSettlements: number;
  unattributedSettlements: number;
  missingEvidence: number;
};

// Inventory of persisted attempts, not a count of inbound traffic or a signature check.
export async function readEvidenceCoverage(access: ControlAccess) {
  const row = await access.db.prepare(`WITH owner AS (
      SELECT tenant_id,principal_id FROM control_memberships WHERE tenant_id=? AND principal_id=? AND active=1 AND role='owner'
    ), classified AS (
      SELECT CASE
        WHEN ${conflictingTerminalOutcomes} THEN 'missing'
        WHEN (p.id IS NOT NULL AND NOT ${hasReceiptCreationEvent("p")})
          OR (f.id IS NOT NULL AND NOT ${hasReceiptCreationEvent("f")}) THEN 'missing'
        WHEN s.intent_id IS NOT NULL AND f.id IS NOT NULL AND b.intent_id IS NULL THEN 'unattributed'
        WHEN s.intent_id IS NOT NULL AND f.id IS NOT NULL AND p.id IS NOT NULL
          AND d.maximum_bytes_billed IS NOT NULL AND o.outcome=json_extract(f.payload,'$.outcome')
          AND f.id='final_'||j.job_id AND b.receipt_id=f.id AND b.actor=s.actor AND f.created_by=b.actor
          AND b.actual_micro_usd=s.actual_units AND b.recorded_at=json_extract(f.payload,'$.recordedAt')
          AND (${nonDelegatedEvidence} OR ${delegatedBillLink}) THEN 'attributed'
        WHEN s.intent_id IS NULL AND b.intent_id IS NULL AND p.id IS NOT NULL AND o.intent_id IS NULL THEN 'pending-outcome'
        WHEN s.intent_id IS NULL AND b.intent_id IS NULL AND p.id IS NOT NULL AND o.intent_id IS NOT NULL
          AND d.maximum_bytes_billed IS NOT NULL AND (${nonDelegatedEvidence} OR ${delegatedObservationLink}) THEN 'pending-bill'
        ELSE 'missing' END AS bucket
      FROM owner m JOIN execution_intents i ON i.tenant_id=m.tenant_id
      LEFT JOIN approval_contracts c ON c.tenant_id=i.tenant_id AND c.id=i.contract_id
      LEFT JOIN bigquery_job_bindings j ON j.tenant_id=i.tenant_id AND j.intent_id=i.id
      LEFT JOIN dispatch_claims d ON d.tenant_id=i.tenant_id AND d.intent_id=i.id
      LEFT JOIN evidence_receipts p ON p.tenant_id=i.tenant_id AND p.id=j.receipt_id
        AND p.contract_id=c.id AND p.release_id=c.release_id AND json_extract(p.payload,'$.intentId')=i.id
        AND json_extract(p.payload,'$.outcome')='pending'
      LEFT JOIN bigquery_terminal_observations o ON o.tenant_id=i.tenant_id AND o.intent_id=i.id
        AND o.has_bytes=(SELECT MIN(x.has_bytes) FROM bigquery_terminal_observations x
          WHERE x.tenant_id=i.tenant_id AND x.intent_id=i.id)
      LEFT JOIN bigquery_billing_evidence b ON b.tenant_id=i.tenant_id AND b.intent_id=i.id
      LEFT JOIN cost_settlements s ON s.tenant_id=i.tenant_id AND s.intent_id=i.id
      LEFT JOIN evidence_receipts f ON f.tenant_id=i.tenant_id AND f.id=s.receipt_id
        AND f.contract_id=c.id AND f.release_id=c.release_id AND json_extract(f.payload,'$.intentId')=i.id
        AND json_extract(f.payload,'$.outcome') IN ('succeeded','failed','cancelled')
      ${delegatedEvidenceJoins}
    ), totals AS (
      SELECT count(*) AS admitted,
        count(*) FILTER (WHERE bucket='pending-outcome') AS pendingOutcome,
        count(*) FILTER (WHERE bucket='pending-bill') AS pendingBilling,
        count(*) FILTER (WHERE bucket='attributed') AS attributedSettlements,
        count(*) FILTER (WHERE bucket='unattributed') AS unattributedSettlements,
        count(*) FILTER (WHERE bucket='missing') AS missingEvidence FROM classified
    )
    SELECT totals.*, (SELECT count(*) FROM missing_release_denials WHERE tenant_id=owner.tenant_id) AS missingReleaseRefusals
    FROM owner CROSS JOIN totals`).bind(access.tenantId, access.principalId).first<CoverageCounts>();
  return row && { ...row, recordedAttempts: row.admitted + row.missingReleaseRefusals };
}
