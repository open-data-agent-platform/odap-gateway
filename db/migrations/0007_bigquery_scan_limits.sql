-- No guessed prices or automatic enablement of existing targets.
CREATE TABLE bigquery_scan_policies (
  tenant_id TEXT NOT NULL REFERENCES control_tenants(id),
  target TEXT NOT NULL,
  policy_revision TEXT NOT NULL,
  project_id TEXT NOT NULL,
  location TEXT NOT NULL,
  billing_mode TEXT NOT NULL CHECK(billing_mode='on_demand'),
  micro_usd_per_tib INTEGER NOT NULL CHECK(typeof(micro_usd_per_tib)='integer' AND micro_usd_per_tib BETWEEN 1 AND 9007199254740991),
  max_job_bytes INTEGER NOT NULL CHECK(typeof(max_job_bytes)='integer' AND max_job_bytes BETWEEN 1 AND 9007199254740991),
  valid_until TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',valid_until) IS valid_until),
  pricing_reference TEXT NOT NULL CHECK(length(trim(pricing_reference))>0),
  PRIMARY KEY(tenant_id,target,policy_revision)
);
CREATE TRIGGER scan_policy_no_update BEFORE UPDATE ON bigquery_scan_policies
BEGIN SELECT RAISE(ABORT,'immutable scan policy'); END;
CREATE TRIGGER scan_policy_no_delete BEFORE DELETE ON bigquery_scan_policies
BEGIN SELECT RAISE(ABORT,'immutable scan policy'); END;
CREATE TRIGGER scan_policy_no_replace BEFORE INSERT ON bigquery_scan_policies
WHEN EXISTS(SELECT 1 FROM bigquery_scan_policies WHERE tenant_id=NEW.tenant_id AND target=NEW.target AND policy_revision=NEW.policy_revision)
BEGIN SELECT RAISE(ABORT,'immutable scan policy'); END;

-- Preserve old claims as evidence with no known ceiling; never backfill one.
ALTER TABLE dispatch_claims ADD COLUMN maximum_bytes_billed INTEGER
  CHECK(maximum_bytes_billed IS NULL OR (typeof(maximum_bytes_billed)='integer' AND maximum_bytes_billed BETWEEN 1 AND 9007199254740991));
CREATE TRIGGER dispatch_claim_requires_limit BEFORE INSERT ON dispatch_claims
WHEN NEW.maximum_bytes_billed IS NULL
BEGIN SELECT RAISE(ABORT,'dispatch requires byte ceiling'); END;
CREATE TRIGGER dispatch_claim_no_replace BEFORE INSERT ON dispatch_claims
WHEN EXISTS(SELECT 1 FROM dispatch_claims WHERE tenant_id=NEW.tenant_id AND intent_id=NEW.intent_id)
BEGIN SELECT RAISE(ABORT,'immutable dispatch claim'); END;

CREATE VIEW dispatch_priced_reads AS
SELECT a.*, i.reserved_units, p.micro_usd_per_tib, p.max_job_bytes
FROM dispatch_eligible_reads a
JOIN execution_intents i ON i.tenant_id=a.tenant_id AND i.id=a.intent_id
JOIN bigquery_scan_policies p ON p.tenant_id=a.tenant_id AND p.target=a.target
  AND p.policy_revision=json_extract(a.contract_payload,'$.policyRevision')
  AND p.project_id=a.project_id AND p.location=a.location
WHERE p.billing_mode='on_demand' AND julianday(p.valid_until)>julianday('now');
