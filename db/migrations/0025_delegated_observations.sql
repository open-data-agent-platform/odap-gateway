ALTER TABLE bigquery_terminal_observations ADD COLUMN delegation_audience TEXT;
ALTER TABLE bigquery_terminal_observations ADD COLUMN claim_body_digest TEXT;

-- Post-claim evidence is about history, not permission to execute again.
-- Current tenant ownership is required; a later grant expiry or revocation
-- must not make the original claim disappear from reconciliation.
CREATE VIEW recoverable_delegated_jobs AS
SELECT h.tenant_id,h.intent_id,h.delegation_audience AS audience,m.principal_id AS operator_id,
  h.compiled_body_digest,h.maximum_bytes_billed AS cap,b.project_id,b.location,b.job_id,b.action_tag,
  b.receipt_id,i.action_digest,i.contract_id,c.release_id,r.payload AS receipt_payload
FROM dispatch_claims h
JOIN delegated_admissions a ON a.tenant_id=h.tenant_id AND a.intent_id=h.intent_id AND a.audience=h.delegation_audience
JOIN bigquery_job_bindings b ON b.tenant_id=h.tenant_id AND b.intent_id=h.intent_id AND b.delegation_audience=a.audience
JOIN delegated_prepared_caps k ON k.tenant_id=b.tenant_id AND k.intent_id=b.intent_id AND k.byte_cap=h.maximum_bytes_billed
JOIN execution_intents i ON i.tenant_id=h.tenant_id AND i.id=h.intent_id AND i.contract_id=a.contract_id
JOIN approval_contracts c ON c.tenant_id=i.tenant_id AND c.id=i.contract_id
JOIN evidence_receipts r ON r.tenant_id=b.tenant_id AND r.id=b.receipt_id AND r.contract_id=c.id AND r.release_id=c.release_id
  AND json_extract(r.payload,'$.intentId')=i.id AND json_extract(r.payload,'$.outcome')='pending'
JOIN control_memberships m ON m.tenant_id=h.tenant_id AND m.role='owner' AND m.active=1
WHERE h.compiled_body_digest IS NOT NULL AND h.maximum_bytes_billed>0
  AND NOT EXISTS(SELECT 1 FROM bigquery_terminal_observations old WHERE old.tenant_id=h.tenant_id AND old.intent_id=h.intent_id
    AND (old.delegation_audience IS NOT h.delegation_audience OR old.claim_body_digest IS NOT h.compiled_body_digest));

CREATE TRIGGER delegated_observation_guard BEFORE INSERT ON bigquery_terminal_observations BEGIN
  SELECT RAISE(ABORT,'verified delegated observation required') WHERE EXISTS(
    SELECT 1 FROM delegated_admissions WHERE tenant_id=NEW.tenant_id AND intent_id=NEW.intent_id)
    AND NOT EXISTS(SELECT 1 FROM recoverable_delegated_jobs WHERE tenant_id=NEW.tenant_id AND intent_id=NEW.intent_id
      AND operator_id=NEW.observed_by AND audience=NEW.delegation_audience AND compiled_body_digest=NEW.claim_body_digest);
  SELECT RAISE(ABORT,'unexpected delegated observation') WHERE
    (NEW.delegation_audience IS NOT NULL OR NEW.claim_body_digest IS NOT NULL)
    AND NOT EXISTS(SELECT 1 FROM delegated_admissions WHERE tenant_id=NEW.tenant_id AND intent_id=NEW.intent_id);
END;
