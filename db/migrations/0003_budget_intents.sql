CREATE TABLE IF NOT EXISTS control_budgets (
  tenant_id TEXT NOT NULL REFERENCES control_tenants(id),
  id TEXT NOT NULL,
  limit_units INTEGER NOT NULL CHECK(typeof(limit_units)='integer' AND limit_units >= 0 AND limit_units <= 9007199254740991),
  reserved_units INTEGER NOT NULL DEFAULT 0 CHECK(typeof(reserved_units)='integer' AND reserved_units >= 0),
  spent_units INTEGER NOT NULL DEFAULT 0 CHECK(typeof(spent_units)='integer' AND spent_units >= 0),
  PRIMARY KEY(tenant_id,id),
  CHECK(reserved_units <= limit_units - spent_units)
);
CREATE TABLE IF NOT EXISTS execution_intents (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  contract_id TEXT NOT NULL,
  budget_id TEXT NOT NULL,
  reservation_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  action_digest TEXT NOT NULL,
  reserved_units INTEGER NOT NULL CHECK(typeof(reserved_units)='integer' AND reserved_units >= 0 AND reserved_units <= 9007199254740991),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(tenant_id,id),
  UNIQUE(tenant_id,contract_id),
  UNIQUE(tenant_id,reservation_id),
  FOREIGN KEY(tenant_id,contract_id) REFERENCES approval_contracts(tenant_id,id),
  FOREIGN KEY(tenant_id,budget_id) REFERENCES control_budgets(tenant_id,id)
);
CREATE TRIGGER IF NOT EXISTS intent_admission BEFORE INSERT ON execution_intents BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM approval_contracts c JOIN contract_lifecycle l ON l.tenant_id=c.tenant_id AND l.contract_id=c.id
    JOIN control_memberships m ON m.tenant_id=c.tenant_id AND m.principal_id=NEW.principal_id
    WHERE c.tenant_id=NEW.tenant_id AND c.id=NEW.contract_id AND l.state='authorized'
      AND m.active=1 AND m.role IN ('reader','reviewer','owner')
      AND json_extract(c.payload,'$.principalId')=NEW.principal_id
      AND json_extract(c.payload,'$.actionDigest')=NEW.action_digest
      AND json_extract(c.payload,'$.reservationId')=NEW.reservation_id
      AND json_extract(c.payload,'$.state')='authorized'
      AND julianday(json_extract(c.payload,'$.expiresAt')) > julianday('now')
  ) THEN RAISE(ABORT,'contract admission denied') END;
  UPDATE control_budgets SET reserved_units=reserved_units+NEW.reserved_units
    WHERE tenant_id=NEW.tenant_id AND id=NEW.budget_id
      AND NEW.reserved_units <= limit_units-spent_units-reserved_units;
  SELECT CASE WHEN changes()<>1 THEN RAISE(ABORT,'budget admission denied') END;
  UPDATE contract_lifecycle SET state='consumed',changed_by=NEW.principal_id,reason='execution intent admitted'
    WHERE tenant_id=NEW.tenant_id AND contract_id=NEW.contract_id AND state='authorized';
  SELECT CASE WHEN changes()<>1 THEN RAISE(ABORT,'contract already consumed') END;
END;
CREATE TRIGGER IF NOT EXISTS intent_no_update BEFORE UPDATE ON execution_intents BEGIN SELECT RAISE(ABORT,'immutable intent'); END;
CREATE TRIGGER IF NOT EXISTS intent_no_delete BEFORE DELETE ON execution_intents BEGIN SELECT RAISE(ABORT,'immutable intent'); END;
