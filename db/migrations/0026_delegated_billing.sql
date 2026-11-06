-- NULLs on old rows mean unverified provenance; do not infer it on upgrade.
ALTER TABLE bigquery_billing_evidence ADD COLUMN delegation_audience TEXT;
ALTER TABLE bigquery_billing_evidence ADD COLUMN claim_body_digest TEXT;
ALTER TABLE bigquery_billing_evidence ADD COLUMN attributed_project TEXT;
ALTER TABLE bigquery_billing_evidence ADD COLUMN attributed_location TEXT;

CREATE VIEW delegated_billing_jobs AS
SELECT j.*,(SELECT o.outcome FROM bigquery_terminal_observations o WHERE o.tenant_id=j.tenant_id
  AND o.intent_id=j.intent_id AND o.delegation_audience=j.audience AND o.claim_body_digest=j.compiled_body_digest
  ORDER BY o.has_bytes DESC LIMIT 1) AS terminal_outcome
FROM recoverable_delegated_jobs j;

CREATE TRIGGER delegated_bill_guard BEFORE INSERT ON bigquery_billing_evidence BEGIN
  SELECT RAISE(ABORT,'attributed delegated bill required') WHERE EXISTS(
    SELECT 1 FROM delegated_admissions WHERE tenant_id=NEW.tenant_id AND intent_id=NEW.intent_id)
    AND NOT EXISTS(SELECT 1 FROM delegated_billing_jobs WHERE tenant_id=NEW.tenant_id AND intent_id=NEW.intent_id
      AND operator_id=NEW.actor AND terminal_outcome IS NOT NULL AND audience=NEW.delegation_audience
      AND compiled_body_digest=NEW.claim_body_digest AND project_id=NEW.attributed_project
      AND location=NEW.attributed_location AND NEW.receipt_id='final_'||job_id);
  SELECT RAISE(ABORT,'unexpected delegated bill') WHERE
    (NEW.delegation_audience IS NOT NULL OR NEW.claim_body_digest IS NOT NULL
      OR NEW.attributed_project IS NOT NULL OR NEW.attributed_location IS NOT NULL)
    AND NOT EXISTS(SELECT 1 FROM delegated_admissions WHERE tenant_id=NEW.tenant_id AND intent_id=NEW.intent_id);
END;

-- The older bounded-job guard starts at dispatch. Hold delegated admissions
-- even before a claim exists: a synthetic final receipt alone cannot debit.
CREATE TRIGGER delegated_settlement_guard BEFORE INSERT ON cost_settlements
WHEN EXISTS(SELECT 1 FROM delegated_admissions WHERE tenant_id=NEW.tenant_id AND intent_id=NEW.intent_id)
  AND NOT EXISTS(SELECT 1 FROM bigquery_billing_evidence b JOIN delegated_billing_jobs j
    ON j.tenant_id=b.tenant_id AND j.intent_id=b.intent_id AND j.operator_id=b.actor
      AND j.audience=b.delegation_audience AND j.compiled_body_digest=b.claim_body_digest
      AND j.project_id=b.attributed_project AND j.location=b.attributed_location
    WHERE b.tenant_id=NEW.tenant_id AND b.intent_id=NEW.intent_id AND b.actor=NEW.actor
      AND b.receipt_id=NEW.receipt_id AND b.receipt_id='final_'||j.job_id AND b.actual_micro_usd=NEW.actual_units
      AND j.terminal_outcome IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'verified delegated billing evidence required'); END;
