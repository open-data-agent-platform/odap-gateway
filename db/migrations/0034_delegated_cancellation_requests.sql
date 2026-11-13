-- Old requests retain NULL provenance; an upgrade cannot establish consent.
ALTER TABLE bigquery_cancellation_requests ADD COLUMN delegation_audience TEXT;
ALTER TABLE bigquery_cancellation_requests ADD COLUMN claim_body_digest TEXT;

CREATE TRIGGER delegated_cancellation_guard BEFORE INSERT ON bigquery_cancellation_requests BEGIN
  SELECT RAISE(ABORT,'verified delegated cancellation required') WHERE EXISTS(
    SELECT 1 FROM delegated_admissions WHERE tenant_id=NEW.tenant_id AND intent_id=NEW.intent_id)
    AND NOT EXISTS(SELECT 1 FROM recoverable_delegated_jobs
      WHERE tenant_id=NEW.tenant_id AND intent_id=NEW.intent_id AND operator_id=NEW.requested_by
        AND job_id=NEW.job_id AND audience=NEW.delegation_audience AND compiled_body_digest=NEW.claim_body_digest);
  SELECT RAISE(ABORT,'unexpected delegated cancellation') WHERE
    (NEW.delegation_audience IS NOT NULL OR NEW.claim_body_digest IS NOT NULL)
    AND NOT EXISTS(SELECT 1 FROM delegated_admissions WHERE tenant_id=NEW.tenant_id AND intent_id=NEW.intent_id);
END;
