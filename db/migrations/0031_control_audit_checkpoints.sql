-- The immutable source log is the outbox. No cursor exists until the first acknowledgment.
CREATE INDEX control_events_by_tenant_sequence ON control_object_events(tenant_id, sequence);
CREATE TABLE control_audit_checkpoints (
  tenant_id TEXT NOT NULL REFERENCES control_tenants(id),
  consumer_id TEXT NOT NULL CHECK(length(consumer_id) BETWEEN 1 AND 128 AND
    instr(consumer_id,char(0))=0 AND consumer_id NOT GLOB '*[^a-zA-Z0-9_-]*'),
  sequence INTEGER NOT NULL REFERENCES control_object_events(sequence),
  acknowledged_by TEXT NOT NULL,
  PRIMARY KEY(tenant_id,consumer_id)
) WITHOUT ROWID;

CREATE TRIGGER control_audit_checkpoint_start BEFORE INSERT ON control_audit_checkpoints BEGIN
  -- Refuse REPLACE even when SQLite recursive triggers are disabled.
  SELECT RAISE(ABORT,'invalid initial checkpoint') WHERE EXISTS (SELECT 1 FROM control_audit_checkpoints
    WHERE tenant_id=NEW.tenant_id AND consumer_id=NEW.consumer_id) OR NEW.sequence IS NOT
    (SELECT MIN(sequence) FROM control_object_events WHERE tenant_id=NEW.tenant_id);
  SELECT RAISE(ABORT,'inactive audit owner') WHERE NOT EXISTS (SELECT 1 FROM control_memberships
    WHERE tenant_id=NEW.tenant_id AND principal_id=NEW.acknowledged_by AND active=1 AND role='owner');
END;
CREATE TRIGGER control_audit_checkpoint_advance BEFORE UPDATE ON control_audit_checkpoints BEGIN
  SELECT RAISE(ABORT,'invalid next checkpoint') WHERE OLD.tenant_id IS NOT NEW.tenant_id OR
    OLD.consumer_id IS NOT NEW.consumer_id OR NEW.sequence IS NOT
    (SELECT MIN(sequence) FROM control_object_events WHERE tenant_id=OLD.tenant_id AND sequence>OLD.sequence);
  SELECT RAISE(ABORT,'inactive audit owner') WHERE NOT EXISTS (SELECT 1 FROM control_memberships
    WHERE tenant_id=NEW.tenant_id AND principal_id=NEW.acknowledged_by AND active=1 AND role='owner');
END;
CREATE TRIGGER control_audit_checkpoint_no_delete BEFORE DELETE ON control_audit_checkpoints
BEGIN SELECT RAISE(ABORT,'cannot discard audit checkpoint'); END;
