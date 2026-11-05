CREATE TABLE IF NOT EXISTS control_tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS control_memberships (
  tenant_id TEXT NOT NULL REFERENCES control_tenants(id),
  principal_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('reader','reviewer','owner')),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  PRIMARY KEY(tenant_id, principal_id)
);
CREATE TABLE IF NOT EXISTS semantic_releases (
  tenant_id TEXT NOT NULL REFERENCES control_tenants(id),
  id TEXT NOT NULL,
  payload TEXT NOT NULL CHECK(json_valid(payload)),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(tenant_id,id),
  CHECK(json_extract(payload,'$.id') IS id),
  CHECK(json_extract(payload,'$.tenantId') IS tenant_id)
);
CREATE TABLE IF NOT EXISTS approval_contracts (
  tenant_id TEXT NOT NULL REFERENCES control_tenants(id),
  id TEXT NOT NULL,
  release_id TEXT NOT NULL,
  payload TEXT NOT NULL CHECK(json_valid(payload)),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(tenant_id,id),
  UNIQUE(tenant_id,id,release_id),
  FOREIGN KEY(tenant_id,release_id) REFERENCES semantic_releases(tenant_id,id),
  CHECK(json_extract(payload,'$.id') IS id),
  CHECK(json_extract(payload,'$.tenantId') IS tenant_id),
  CHECK(json_extract(payload,'$.semanticReleaseId') IS release_id)
);
CREATE TABLE IF NOT EXISTS evidence_receipts (
  tenant_id TEXT NOT NULL REFERENCES control_tenants(id),
  id TEXT NOT NULL,
  release_id TEXT,
  contract_id TEXT,
  payload TEXT NOT NULL CHECK(json_valid(payload)),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(tenant_id,id),
  FOREIGN KEY(tenant_id,release_id) REFERENCES semantic_releases(tenant_id,id),
  FOREIGN KEY(tenant_id,contract_id) REFERENCES approval_contracts(tenant_id,id),
  FOREIGN KEY(tenant_id,contract_id,release_id) REFERENCES approval_contracts(tenant_id,id,release_id),
  CHECK(json_extract(payload,'$.id') IS id),
  CHECK(json_extract(payload,'$.tenantId') IS tenant_id),
  CHECK(json_extract(payload,'$.contractId') IS contract_id),
  CHECK(json_extract(payload,'$.semanticReleaseId') IS release_id),
  CHECK(json_extract(payload,'$.outcome') = 'denied' OR (release_id IS NOT NULL AND contract_id IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS control_object_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  object_kind TEXT NOT NULL,
  object_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TRIGGER IF NOT EXISTS release_created AFTER INSERT ON semantic_releases BEGIN
  INSERT INTO control_object_events(tenant_id,object_kind,object_id,actor) VALUES(NEW.tenant_id,'release',NEW.id,NEW.created_by);
END;
CREATE TRIGGER IF NOT EXISTS contract_created AFTER INSERT ON approval_contracts BEGIN
  INSERT INTO control_object_events(tenant_id,object_kind,object_id,actor) VALUES(NEW.tenant_id,'contract',NEW.id,NEW.created_by);
END;
CREATE TRIGGER IF NOT EXISTS receipt_created AFTER INSERT ON evidence_receipts BEGIN
  INSERT INTO control_object_events(tenant_id,object_kind,object_id,actor) VALUES(NEW.tenant_id,'receipt',NEW.id,NEW.created_by);
END;
CREATE TRIGGER IF NOT EXISTS release_immutable_update BEFORE UPDATE ON semantic_releases BEGIN SELECT RAISE(ABORT,'immutable object'); END;
CREATE TRIGGER IF NOT EXISTS release_immutable_delete BEFORE DELETE ON semantic_releases BEGIN SELECT RAISE(ABORT,'immutable object'); END;
CREATE TRIGGER IF NOT EXISTS contract_immutable_update BEFORE UPDATE ON approval_contracts BEGIN SELECT RAISE(ABORT,'immutable object'); END;
CREATE TRIGGER IF NOT EXISTS contract_immutable_delete BEFORE DELETE ON approval_contracts BEGIN SELECT RAISE(ABORT,'immutable object'); END;
CREATE TRIGGER IF NOT EXISTS receipt_immutable_update BEFORE UPDATE ON evidence_receipts BEGIN SELECT RAISE(ABORT,'immutable object'); END;
CREATE TRIGGER IF NOT EXISTS receipt_immutable_delete BEFORE DELETE ON evidence_receipts BEGIN SELECT RAISE(ABORT,'immutable object'); END;
