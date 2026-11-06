ALTER TABLE dispatch_claims ADD COLUMN delegation_audience TEXT;
ALTER TABLE dispatch_claims ADD COLUMN compiled_body_digest TEXT
  CHECK(compiled_body_digest IS NULL OR (length(compiled_body_digest)=71
    AND substr(compiled_body_digest,1,7)='sha256:' AND substr(compiled_body_digest,8) NOT GLOB '*[^0-9a-f]*'));

-- Exact floor(units * 2^40 / rate), clamped to the job limit. Doubling
-- the quotient and remainder keeps intermediates inside SQLite INTEGER
-- even when the naive product would overflow and silently become REAL.
CREATE VIEW delegated_prepared_caps AS
SELECT b.tenant_id,b.intent_id,(WITH RECURSIVE bits(n,q,r) AS (
  SELECT 0,min(b.prepared_byte_limit,b.prepared_reserved_units/b.prepared_rate),b.prepared_reserved_units%b.prepared_rate
  UNION ALL SELECT n+1,min(b.prepared_byte_limit,2*q+2*r/b.prepared_rate),2*r%b.prepared_rate
    FROM bits WHERE n<40 AND q<b.prepared_byte_limit
) SELECT q FROM bits WHERE n=40 OR q=b.prepared_byte_limit) AS byte_cap
FROM bigquery_job_bindings b WHERE b.delegation_audience IS NOT NULL;

CREATE VIEW claimable_delegated_reads AS
SELECT j.*,e.principal_id,json_extract(c.payload,'$.agentId') AS agent_id,
  c.payload AS contract_payload,r.payload AS release_payload,r.definition_json,u.payload AS receipt_payload,
  b.job_id,b.action_tag,b.receipt_id,k.byte_cap
FROM preparable_delegated_jobs j
JOIN bigquery_job_bindings b ON b.tenant_id=j.tenant_id AND b.intent_id=j.intent_id AND b.delegation_audience=j.audience
  AND b.project_id=j.project_id AND b.location=j.location AND b.prepared_rate=j.micro_usd_per_tib
  AND b.prepared_reserved_units=j.reserved_units AND b.prepared_byte_limit=j.max_job_bytes
JOIN delegated_prepared_caps k ON k.tenant_id=j.tenant_id AND k.intent_id=j.intent_id AND k.byte_cap>0
JOIN execution_intents e ON e.tenant_id=j.tenant_id AND e.id=j.intent_id
JOIN approval_contracts c ON c.tenant_id=e.tenant_id AND c.id=e.contract_id
JOIN requestable_metric_releases r ON r.tenant_id=c.tenant_id AND r.release_id=c.release_id AND r.project_id=j.project_id
JOIN evidence_receipts u ON u.tenant_id=j.tenant_id AND u.id=b.receipt_id AND u.contract_id=c.id AND u.release_id=r.release_id
  AND json_extract(u.payload,'$.intentId')=j.intent_id AND json_extract(u.payload,'$.outcome')='pending'
WHERE NOT EXISTS(SELECT 1 FROM dispatch_claims h WHERE h.tenant_id=j.tenant_id AND h.intent_id=j.intent_id);

-- A legacy insert still cannot claim a delegated job. The trusted compiler
-- supplies the body digest; the write gate independently enforces the cap.
DROP TRIGGER delegated_dispatch_hold;
CREATE TRIGGER delegated_claim_guard BEFORE INSERT ON dispatch_claims BEGIN
  SELECT RAISE(ABORT,'delegated claim denied') WHERE EXISTS(
    SELECT 1 FROM delegated_admissions WHERE tenant_id=NEW.tenant_id AND intent_id=NEW.intent_id)
    AND (NEW.compiled_body_digest IS NULL OR NOT EXISTS(SELECT 1 FROM claimable_delegated_reads
      WHERE tenant_id=NEW.tenant_id AND intent_id=NEW.intent_id AND audience=NEW.delegation_audience
      AND operator_id=NEW.claimed_by AND byte_cap=NEW.maximum_bytes_billed));
  SELECT RAISE(ABORT,'unexpected delegated claim') WHERE
    (NEW.compiled_body_digest IS NOT NULL OR NEW.delegation_audience IS NOT NULL)
    AND NOT EXISTS(SELECT 1 FROM delegated_admissions WHERE tenant_id=NEW.tenant_id AND intent_id=NEW.intent_id);
  SELECT RAISE(ABORT,'immutable delegated claim') WHERE EXISTS(
    SELECT 1 FROM dispatch_claims WHERE rowid=NEW.rowid AND delegation_audience IS NOT NULL);
END;
