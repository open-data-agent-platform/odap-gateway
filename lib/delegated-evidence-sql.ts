import { terminalOutcomesConflict } from "./terminal-outcome-sql";

export const conflictingTerminalOutcomes = terminalOutcomesConflict("i");

// Both inventory and export read these links in one tenant-owner snapshot.
// The recovery view binds the immutable admission, job, prepared cap and
// claim, and excludes *any* differently scoped terminal observation.
export const delegatedEvidenceJoins = `LEFT JOIN delegated_admissions a
    ON a.tenant_id=i.tenant_id AND a.intent_id=i.id
  LEFT JOIN recoverable_delegated_jobs v ON v.tenant_id=i.tenant_id AND v.intent_id=i.id
    AND v.audience=a.audience AND v.operator_id=m.principal_id`;

export const nonDelegatedEvidence = `(a.intent_id IS NULL AND j.delegation_audience IS NULL
  AND d.delegation_audience IS NULL AND d.compiled_body_digest IS NULL
  AND o.delegation_audience IS NULL AND o.claim_body_digest IS NULL
  AND b.delegation_audience IS NULL AND b.claim_body_digest IS NULL
  AND b.attributed_project IS NULL AND b.attributed_location IS NULL
  AND NOT EXISTS (SELECT 1 FROM delegated_contract_issuances issued
    WHERE issued.tenant_id=i.tenant_id AND issued.contract_id=i.contract_id))`;

export const delegatedObservationLink = `(v.intent_id IS NOT NULL AND o.delegation_audience=v.audience
  AND o.claim_body_digest=v.compiled_body_digest)`;

export const delegatedBillLink = `(${delegatedObservationLink}
  AND b.delegation_audience=v.audience AND b.claim_body_digest=v.compiled_body_digest
  AND b.attributed_project=v.project_id AND b.attributed_location=v.location
  AND b.receipt_id='final_'||v.job_id AND s.actor=b.actor AND f.created_by=b.actor)`;
