-- The original budget counter cannot exceed its limit. Record excess liabilities
-- separately, preserve actual cost in settlement records, and freeze admission.
ALTER TABLE control_budgets ADD COLUMN overrun_units INTEGER NOT NULL DEFAULT 0
  CHECK(typeof(overrun_units)='integer' AND overrun_units >= 0 AND overrun_units <= 9007199254740991);
CREATE TRIGGER IF NOT EXISTS intent_overrun_guard BEFORE INSERT ON execution_intents
WHEN EXISTS(SELECT 1 FROM control_budgets WHERE tenant_id=NEW.tenant_id AND id=NEW.budget_id AND overrun_units>0)
BEGIN SELECT RAISE(ABORT,'budget has unresolved overrun'); END;
CREATE TABLE cost_settlements (
  tenant_id TEXT NOT NULL,
  intent_id TEXT NOT NULL,
  receipt_id TEXT NOT NULL,
  actual_units INTEGER NOT NULL CHECK(typeof(actual_units)='integer' AND actual_units>=0 AND actual_units<=9007199254740991),
  actor TEXT NOT NULL,
  recorded_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(tenant_id,intent_id),
  UNIQUE(tenant_id,receipt_id),
  FOREIGN KEY(tenant_id,intent_id) REFERENCES execution_intents(tenant_id,id),
  FOREIGN KEY(tenant_id,receipt_id) REFERENCES evidence_receipts(tenant_id,id)
);
CREATE TRIGGER settlement_guard BEFORE INSERT ON cost_settlements BEGIN
  SELECT CASE WHEN NOT EXISTS(
    SELECT 1 FROM execution_intents i JOIN evidence_receipts r ON r.tenant_id=i.tenant_id
    JOIN approval_contracts c ON c.tenant_id=i.tenant_id AND c.id=i.contract_id
    JOIN control_memberships m ON m.tenant_id=i.tenant_id AND m.principal_id=NEW.actor
    WHERE i.tenant_id=NEW.tenant_id AND i.id=NEW.intent_id AND r.id=NEW.receipt_id
      AND r.contract_id=i.contract_id AND r.release_id=c.release_id
      AND json_extract(r.payload,'$.intentId')=i.id
      AND json_extract(r.payload,'$.outcome') IN ('succeeded','failed','cancelled')
      AND m.active=1 AND m.role='owner'
  ) THEN RAISE(ABORT,'invalid settlement authority or evidence') END;
END;
CREATE TRIGGER settlement_apply AFTER INSERT ON cost_settlements BEGIN
  UPDATE control_budgets SET reserved_units=reserved_units-(SELECT reserved_units FROM execution_intents WHERE tenant_id=NEW.tenant_id AND id=NEW.intent_id)
    WHERE tenant_id=NEW.tenant_id AND id=(SELECT budget_id FROM execution_intents WHERE tenant_id=NEW.tenant_id AND id=NEW.intent_id);
  UPDATE control_budgets SET
    overrun_units=overrun_units+MAX(0,NEW.actual_units-(limit_units-spent_units-reserved_units)),
    spent_units=spent_units+MIN(NEW.actual_units,limit_units-spent_units-reserved_units)
    WHERE tenant_id=NEW.tenant_id AND id=(SELECT budget_id FROM execution_intents WHERE tenant_id=NEW.tenant_id AND id=NEW.intent_id);
END;
CREATE TRIGGER settlement_no_update BEFORE UPDATE ON cost_settlements BEGIN SELECT RAISE(ABORT,'immutable settlement'); END;
CREATE TRIGGER settlement_no_delete BEFORE DELETE ON cost_settlements BEGIN SELECT RAISE(ABORT,'immutable settlement'); END;
