CREATE TABLE IF NOT EXISTS contract_lifecycle (
  tenant_id TEXT NOT NULL,
  contract_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('authorized','consumed','revoked')),
  changed_by TEXT NOT NULL,
  reason TEXT NOT NULL,
  PRIMARY KEY(tenant_id,contract_id),
  FOREIGN KEY(tenant_id,contract_id) REFERENCES approval_contracts(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS contract_lifecycle_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  contract_id TEXT NOT NULL,
  state TEXT NOT NULL,
  actor TEXT NOT NULL,
  reason TEXT NOT NULL,
  recorded_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TRIGGER IF NOT EXISTS lifecycle_created AFTER INSERT ON contract_lifecycle BEGIN
  INSERT INTO contract_lifecycle_events(tenant_id,contract_id,state,actor,reason)
  VALUES(NEW.tenant_id,NEW.contract_id,NEW.state,NEW.changed_by,NEW.reason);
END;
CREATE TRIGGER IF NOT EXISTS lifecycle_transition_guard BEFORE UPDATE ON contract_lifecycle
WHEN OLD.state <> 'authorized' OR NEW.state NOT IN ('consumed','revoked')
  OR OLD.tenant_id <> NEW.tenant_id OR OLD.contract_id <> NEW.contract_id
BEGIN SELECT RAISE(ABORT,'invalid contract transition'); END;
CREATE TRIGGER IF NOT EXISTS lifecycle_changed AFTER UPDATE ON contract_lifecycle BEGIN
  INSERT INTO contract_lifecycle_events(tenant_id,contract_id,state,actor,reason)
  VALUES(NEW.tenant_id,NEW.contract_id,NEW.state,NEW.changed_by,NEW.reason);
END;
CREATE TRIGGER IF NOT EXISTS lifecycle_no_delete BEFORE DELETE ON contract_lifecycle BEGIN
  SELECT RAISE(ABORT,'lifecycle deletion forbidden');
END;
CREATE TRIGGER IF NOT EXISTS contract_initialize_lifecycle AFTER INSERT ON approval_contracts BEGIN
  INSERT INTO contract_lifecycle(tenant_id,contract_id,state,changed_by,reason)
  VALUES(NEW.tenant_id,NEW.id,json_extract(NEW.payload,'$.state'),NEW.created_by,'initial snapshot');
END;
INSERT OR IGNORE INTO contract_lifecycle(tenant_id,contract_id,state,changed_by,reason)
  SELECT tenant_id,id,json_extract(payload,'$.state'),created_by,'migration snapshot' FROM approval_contracts;
