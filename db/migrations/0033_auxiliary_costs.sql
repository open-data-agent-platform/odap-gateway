-- Accounting only: these holds do not grant model or tool execution authority.
CREATE TABLE auxiliary_cost_reservations (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL CHECK(length(id) BETWEEN 1 AND 128 AND instr(id,char(0))=0 AND id NOT GLOB '*[^a-zA-Z0-9:._/-]*'),
  intent_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('model','tool')),
  operation_ref TEXT NOT NULL CHECK(length(operation_ref) BETWEEN 1 AND 256 AND instr(operation_ref,char(0))=0 AND operation_ref NOT GLOB '*[^a-zA-Z0-9:._/-]*'),
  operation_digest TEXT NOT NULL CHECK(length(operation_digest)=71 AND instr(operation_digest,char(0))=0 AND substr(operation_digest,1,7)='sha256:' AND substr(operation_digest,8) NOT GLOB '*[^a-f0-9]*'),
  reserved_units INTEGER NOT NULL CHECK(typeof(reserved_units)='integer' AND reserved_units>0 AND reserved_units<=9007199254740991),
  actor TEXT NOT NULL,
  recorded_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(tenant_id,id),
  UNIQUE(tenant_id,operation_ref),
  FOREIGN KEY(tenant_id,intent_id) REFERENCES execution_intents(tenant_id,id)
);
CREATE TABLE auxiliary_cost_settlements (
  tenant_id TEXT NOT NULL,
  reservation_id TEXT NOT NULL,
  operation_ref TEXT NOT NULL,
  billing_ref TEXT NOT NULL CHECK(length(billing_ref) BETWEEN 1 AND 256 AND instr(billing_ref,char(0))=0 AND billing_ref NOT GLOB '*[^a-zA-Z0-9:._/-]*'),
  actual_units INTEGER NOT NULL CHECK(typeof(actual_units)='integer' AND actual_units>=0 AND actual_units<=9007199254740991),
  actor TEXT NOT NULL,
  recorded_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(tenant_id,reservation_id),
  UNIQUE(tenant_id,billing_ref),
  FOREIGN KEY(tenant_id,reservation_id) REFERENCES auxiliary_cost_reservations(tenant_id,id)
);

CREATE TRIGGER auxiliary_reservation_guard BEFORE INSERT ON auxiliary_cost_reservations BEGIN
  SELECT RAISE(ABORT,'immutable auxiliary reservation') WHERE EXISTS(SELECT 1 FROM auxiliary_cost_reservations
    WHERE tenant_id=NEW.tenant_id AND (id=NEW.id OR operation_ref=NEW.operation_ref));
  SELECT RAISE(ABORT,'invalid auxiliary accounting authority') WHERE NOT EXISTS(SELECT 1 FROM control_memberships
    WHERE tenant_id=NEW.tenant_id AND principal_id=NEW.actor AND active=1 AND role='owner');
END;
CREATE TRIGGER auxiliary_reservation_apply AFTER INSERT ON auxiliary_cost_reservations BEGIN
  UPDATE control_budgets SET reserved_units=reserved_units+NEW.reserved_units
    WHERE tenant_id=NEW.tenant_id AND id=(SELECT budget_id FROM execution_intents WHERE tenant_id=NEW.tenant_id AND id=NEW.intent_id)
      AND overrun_units=0 AND NEW.reserved_units<=limit_units-spent_units-reserved_units;
  SELECT RAISE(ABORT,'auxiliary budget unavailable') WHERE changes()<>1;
  INSERT INTO control_object_events(tenant_id,object_kind,object_id,actor)
    VALUES(NEW.tenant_id,'auxiliary_cost_reserved',NEW.id,NEW.actor);
  SELECT RAISE(ABORT,'auxiliary audit required') WHERE changes()<>1;
END;
CREATE TRIGGER auxiliary_settlement_guard BEFORE INSERT ON auxiliary_cost_settlements BEGIN
  SELECT RAISE(ABORT,'immutable auxiliary settlement') WHERE EXISTS(SELECT 1 FROM auxiliary_cost_settlements
    WHERE tenant_id=NEW.tenant_id AND (reservation_id=NEW.reservation_id OR billing_ref=NEW.billing_ref));
  SELECT RAISE(ABORT,'invalid auxiliary accounting authority') WHERE NOT EXISTS(SELECT 1 FROM control_memberships
    WHERE tenant_id=NEW.tenant_id AND principal_id=NEW.actor AND active=1 AND role='owner');
  SELECT RAISE(ABORT,'auxiliary bill attribution mismatch') WHERE NOT EXISTS(SELECT 1 FROM auxiliary_cost_reservations
    WHERE tenant_id=NEW.tenant_id AND id=NEW.reservation_id AND operation_ref=NEW.operation_ref);
END;
CREATE TRIGGER auxiliary_settlement_apply AFTER INSERT ON auxiliary_cost_settlements BEGIN
  UPDATE control_budgets SET reserved_units=reserved_units-(SELECT reserved_units FROM auxiliary_cost_reservations
    WHERE tenant_id=NEW.tenant_id AND id=NEW.reservation_id)
    WHERE tenant_id=NEW.tenant_id AND id=(SELECT i.budget_id FROM execution_intents i JOIN auxiliary_cost_reservations r
      ON r.tenant_id=i.tenant_id AND r.intent_id=i.id WHERE r.tenant_id=NEW.tenant_id AND r.id=NEW.reservation_id);
  SELECT RAISE(ABORT,'auxiliary reservation release failed') WHERE changes()<>1;
  UPDATE control_budgets SET
    overrun_units=overrun_units+MAX(0,NEW.actual_units-(limit_units-spent_units-reserved_units)),
    spent_units=spent_units+MIN(NEW.actual_units,limit_units-spent_units-reserved_units)
    WHERE tenant_id=NEW.tenant_id AND id=(SELECT i.budget_id FROM execution_intents i JOIN auxiliary_cost_reservations r
      ON r.tenant_id=i.tenant_id AND r.intent_id=i.id WHERE r.tenant_id=NEW.tenant_id AND r.id=NEW.reservation_id);
  SELECT RAISE(ABORT,'auxiliary charge recording failed') WHERE changes()<>1;
  INSERT INTO control_object_events(tenant_id,object_kind,object_id,actor)
    VALUES(NEW.tenant_id,'auxiliary_cost_settled',NEW.reservation_id,NEW.actor);
  SELECT RAISE(ABORT,'auxiliary audit required') WHERE changes()<>1;
END;
CREATE TRIGGER auxiliary_reservation_no_update BEFORE UPDATE ON auxiliary_cost_reservations
BEGIN SELECT RAISE(ABORT,'immutable auxiliary reservation'); END;
CREATE TRIGGER auxiliary_reservation_no_delete BEFORE DELETE ON auxiliary_cost_reservations
BEGIN SELECT RAISE(ABORT,'immutable auxiliary reservation'); END;
CREATE TRIGGER auxiliary_settlement_no_update BEFORE UPDATE ON auxiliary_cost_settlements
BEGIN SELECT RAISE(ABORT,'immutable auxiliary settlement'); END;
CREATE TRIGGER auxiliary_settlement_no_delete BEFORE DELETE ON auxiliary_cost_settlements
BEGIN SELECT RAISE(ABORT,'immutable auxiliary settlement'); END;
