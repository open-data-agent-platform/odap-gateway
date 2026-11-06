-- Operator policy, not a client estimate. Changing the binding requires a new
-- policy revision and consent. No default or backfill for existing contracts.
CREATE TABLE delegated_budget_policies (
  tenant_id TEXT NOT NULL, target TEXT NOT NULL, policy_revision TEXT NOT NULL,
  budget_id TEXT NOT NULL, per_read_micro_usd INTEGER NOT NULL
    CHECK(typeof(per_read_micro_usd)='integer' AND per_read_micro_usd BETWEEN 1 AND 9007199254740991),
  PRIMARY KEY(tenant_id,target,policy_revision),
  FOREIGN KEY(tenant_id,target,policy_revision) REFERENCES bigquery_scan_policies(tenant_id,target,policy_revision),
  FOREIGN KEY(tenant_id,budget_id) REFERENCES control_budgets(tenant_id,id)
) WITHOUT ROWID;
CREATE TRIGGER delegated_budget_no_replace BEFORE INSERT ON delegated_budget_policies
WHEN EXISTS(SELECT 1 FROM delegated_budget_policies WHERE tenant_id=NEW.tenant_id AND target=NEW.target AND policy_revision=NEW.policy_revision)
BEGIN SELECT RAISE(ABORT,'immutable delegated budget policy'); END;
CREATE TRIGGER delegated_budget_no_update BEFORE UPDATE ON delegated_budget_policies
BEGIN SELECT RAISE(ABORT,'immutable delegated budget policy'); END;
CREATE TRIGGER delegated_budget_no_delete BEFORE DELETE ON delegated_budget_policies
BEGIN SELECT RAISE(ABORT,'retain delegated budget policy'); END;

CREATE VIEW admissible_delegated_contracts AS
SELECT i.tenant_id,i.contract_id,i.audience,i.requested_by,i.reservation_id,d.action_digest,
  p.budget_id,p.per_read_micro_usd
FROM delegated_contract_issuances i JOIN issuable_delegations d ON d.tenant_id=i.tenant_id
  AND d.delegation_id=i.delegation_id AND d.audience=i.audience AND d.requester_id=i.requested_by
JOIN contract_lifecycle l ON l.tenant_id=i.tenant_id AND l.contract_id=i.contract_id AND l.state='authorized'
JOIN contract_human_grants g ON g.tenant_id=d.tenant_id AND g.id=d.grant_id
JOIN delegated_budget_policies p ON p.tenant_id=d.tenant_id AND p.target=d.target AND p.policy_revision=d.policy_revision
JOIN bigquery_scan_policies s ON s.tenant_id=p.tenant_id AND s.target=p.target AND s.policy_revision=p.policy_revision
  AND s.project_id=g.project_id AND s.location=g.location AND julianday(s.valid_until)>julianday('now')
JOIN control_budgets b ON b.tenant_id=p.tenant_id AND b.id=p.budget_id
WHERE b.overrun_units=0 AND p.per_read_micro_usd<=b.limit_units-b.spent_units-b.reserved_units
  -- Refuse a policy allowance too small to fund even one byte at the pinned rate.
  AND p.per_read_micro_usd>=1+(s.micro_usd_per_tib-1)/1099511627776;

CREATE TABLE delegated_admissions (
  tenant_id TEXT NOT NULL, contract_id TEXT NOT NULL, intent_id TEXT NOT NULL,
  audience TEXT NOT NULL, requested_by TEXT NOT NULL,
  PRIMARY KEY(tenant_id,contract_id), UNIQUE(tenant_id,intent_id),
  FOREIGN KEY(tenant_id,contract_id) REFERENCES delegated_contract_issuances(tenant_id,contract_id),
  FOREIGN KEY(tenant_id,intent_id) REFERENCES execution_intents(tenant_id,id)
) WITHOUT ROWID;
CREATE TRIGGER delegated_admission_no_replace BEFORE INSERT ON delegated_admissions
WHEN EXISTS(SELECT 1 FROM delegated_admissions WHERE tenant_id=NEW.tenant_id AND
  (contract_id=NEW.contract_id OR intent_id=NEW.intent_id))
  OR EXISTS(SELECT 1 FROM execution_intents WHERE tenant_id=NEW.tenant_id AND id=NEW.intent_id)
BEGIN SELECT RAISE(ABORT,'admission identity conflict'); END;
CREATE TRIGGER delegated_admission_no_update BEFORE UPDATE ON delegated_admissions
BEGIN SELECT RAISE(ABORT,'immutable delegated admission'); END;
CREATE TRIGGER delegated_admission_no_delete BEFORE DELETE ON delegated_admissions
BEGIN SELECT RAISE(ABORT,'retain delegated admission'); END;

-- Only the admission INSERT opens the old consumption/intent gates. The
-- nested intent INSERT uses policy values, never money or scope from clients.
DROP TRIGGER issued_contract_hold;
CREATE TRIGGER issued_contract_hold BEFORE UPDATE ON contract_lifecycle
WHEN NEW.state='consumed' AND EXISTS(SELECT 1 FROM delegated_contract_issuances
  WHERE tenant_id=OLD.tenant_id AND contract_id=OLD.contract_id)
  AND NOT EXISTS(SELECT 1 FROM delegated_admissions WHERE tenant_id=OLD.tenant_id AND contract_id=OLD.contract_id)
BEGIN SELECT RAISE(ABORT,'delegated admission required'); END;
DROP TRIGGER issued_intent_hold;
CREATE TRIGGER issued_intent_hold BEFORE INSERT ON execution_intents
WHEN EXISTS(SELECT 1 FROM delegated_contract_issuances WHERE tenant_id=NEW.tenant_id AND contract_id=NEW.contract_id)
  AND NOT EXISTS(SELECT 1 FROM delegated_admissions WHERE tenant_id=NEW.tenant_id AND contract_id=NEW.contract_id AND intent_id=NEW.id)
BEGIN SELECT RAISE(ABORT,'delegated admission required'); END;
CREATE TRIGGER delegated_intent_no_replace BEFORE INSERT ON execution_intents
WHEN EXISTS(SELECT 1 FROM execution_intents e JOIN delegated_admissions a ON a.tenant_id=e.tenant_id AND a.intent_id=e.id
  WHERE e.rowid=NEW.rowid OR (e.tenant_id=NEW.tenant_id AND
  (e.id=NEW.id OR e.contract_id=NEW.contract_id OR e.reservation_id=NEW.reservation_id)))
BEGIN SELECT RAISE(ABORT,'immutable admitted intent'); END;
CREATE TRIGGER admit_delegated_intent AFTER INSERT ON delegated_admissions BEGIN
  INSERT INTO execution_intents(tenant_id,id,contract_id,budget_id,reservation_id,principal_id,action_digest,reserved_units)
  SELECT tenant_id,NEW.intent_id,contract_id,budget_id,reservation_id,requested_by,action_digest,per_read_micro_usd
    FROM admissible_delegated_contracts WHERE tenant_id=NEW.tenant_id AND contract_id=NEW.contract_id
    AND audience=NEW.audience AND requested_by=NEW.requested_by;
  SELECT CASE WHEN changes()<>1 THEN RAISE(ABORT,'delegated admission denied') END;
END;

-- No warehouse handoff until the dispatch path rechecks delegation as well.
CREATE TRIGGER delegated_job_hold BEFORE INSERT ON bigquery_job_bindings
WHEN EXISTS(SELECT 1 FROM delegated_admissions WHERE tenant_id=NEW.tenant_id AND intent_id=NEW.intent_id)
BEGIN SELECT RAISE(ABORT,'delegated dispatch disabled'); END;
