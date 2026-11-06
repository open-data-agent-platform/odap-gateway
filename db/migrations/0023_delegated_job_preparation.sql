-- An admitted contract is consumed, so preparation must check the existing
-- reservation, not demand capacity for a second one.
CREATE VIEW preparable_delegated_jobs AS
SELECT a.tenant_id,a.intent_id,a.audience,o.principal_id AS operator_id,
  e.action_digest,g.project_id,g.location,e.reserved_units,s.micro_usd_per_tib,s.max_job_bytes
FROM delegated_admissions a
JOIN delegated_contract_issuances i ON i.tenant_id=a.tenant_id AND i.contract_id=a.contract_id
  AND i.audience=a.audience AND i.requested_by=a.requested_by
JOIN issuable_delegations d ON d.tenant_id=i.tenant_id AND d.delegation_id=i.delegation_id
  AND d.audience=i.audience AND d.requester_id=i.requested_by
JOIN contract_human_grants g ON g.tenant_id=d.tenant_id AND g.id=d.grant_id
JOIN execution_intents e ON e.tenant_id=a.tenant_id AND e.id=a.intent_id AND e.contract_id=a.contract_id
  AND e.principal_id=a.requested_by AND e.reservation_id=i.reservation_id AND e.action_digest=d.action_digest
JOIN contract_lifecycle l ON l.tenant_id=a.tenant_id AND l.contract_id=a.contract_id AND l.state='consumed'
JOIN delegated_budget_policies p ON p.tenant_id=d.tenant_id AND p.target=d.target AND p.policy_revision=d.policy_revision
  AND p.budget_id=e.budget_id AND p.per_read_micro_usd=e.reserved_units
JOIN bigquery_scan_policies s ON s.tenant_id=p.tenant_id AND s.target=p.target AND s.policy_revision=p.policy_revision
  AND s.project_id=g.project_id AND s.location=g.location AND julianday(s.valid_until)>julianday('now')
JOIN control_budgets b ON b.tenant_id=e.tenant_id AND b.id=e.budget_id AND b.overrun_units=0 AND b.reserved_units>=e.reserved_units
JOIN control_memberships o ON o.tenant_id=a.tenant_id AND o.role='owner' AND o.active=1
WHERE NOT EXISTS(SELECT 1 FROM cost_settlements WHERE tenant_id=a.tenant_id AND intent_id=a.intent_id)
  AND NOT EXISTS(SELECT 1 FROM dispatch_stopped_intents WHERE tenant_id=a.tenant_id AND intent_id=a.intent_id);

-- No inferred limits on historical jobs. For delegated jobs the exact three
-- integer inputs reproduce the affordable byte ceiling without SQL rounding.
ALTER TABLE bigquery_job_bindings ADD COLUMN delegation_audience TEXT;
ALTER TABLE bigquery_job_bindings ADD COLUMN prepared_reserved_units INTEGER;
ALTER TABLE bigquery_job_bindings ADD COLUMN prepared_rate INTEGER;
ALTER TABLE bigquery_job_bindings ADD COLUMN prepared_byte_limit INTEGER;

DROP TRIGGER delegated_job_hold;
CREATE TRIGGER delegated_job_guard BEFORE INSERT ON bigquery_job_bindings BEGIN
  SELECT RAISE(ABORT,'delegated preparation required') WHERE
    EXISTS(SELECT 1 FROM delegated_admissions WHERE tenant_id=NEW.tenant_id AND intent_id=NEW.intent_id)
    AND NOT EXISTS(SELECT 1 FROM preparable_delegated_jobs j WHERE j.tenant_id=NEW.tenant_id AND j.intent_id=NEW.intent_id
      AND j.operator_id=NEW.prepared_by AND j.audience=NEW.delegation_audience
      AND j.project_id=NEW.project_id AND j.location=NEW.location AND j.reserved_units=NEW.prepared_reserved_units
      AND j.micro_usd_per_tib=NEW.prepared_rate AND j.max_job_bytes=NEW.prepared_byte_limit);
  SELECT RAISE(ABORT,'unexpected delegated terms') WHERE
    (NEW.delegation_audience IS NOT NULL OR NEW.prepared_reserved_units IS NOT NULL
      OR NEW.prepared_rate IS NOT NULL OR NEW.prepared_byte_limit IS NOT NULL)
    AND NOT EXISTS(SELECT 1 FROM delegated_admissions WHERE tenant_id=NEW.tenant_id AND intent_id=NEW.intent_id);
  SELECT RAISE(ABORT,'immutable delegated job') WHERE EXISTS(SELECT 1 FROM bigquery_job_bindings
    WHERE rowid=NEW.rowid AND delegation_audience IS NOT NULL);
END;
CREATE TRIGGER delegated_dispatch_hold BEFORE INSERT ON dispatch_claims
WHEN EXISTS(SELECT 1 FROM delegated_admissions WHERE tenant_id=NEW.tenant_id AND intent_id=NEW.intent_id)
BEGIN SELECT RAISE(ABORT,'delegated dispatch disabled'); END;
