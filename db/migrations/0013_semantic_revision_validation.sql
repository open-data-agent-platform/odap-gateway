-- These records precede a release. No legacy release acquires review evidence.
CREATE TABLE semantic_candidate_revisions (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  definition_json TEXT NOT NULL CHECK(json_valid(definition_json)),
  definition_digest TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  provenance_ref TEXT NOT NULL CHECK(length(trim(provenance_ref)) > 0),
  proposed_by TEXT NOT NULL,
  proposed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(tenant_id,id),
  UNIQUE(tenant_id,id,definition_digest,owner_id),
  FOREIGN KEY(tenant_id,owner_id) REFERENCES control_memberships(tenant_id,principal_id),
  FOREIGN KEY(tenant_id,proposed_by) REFERENCES control_memberships(tenant_id,principal_id),
  CHECK(json_extract(definition_json,'$.tenantId') IS tenant_id)
);

CREATE TABLE semantic_candidate_validations (
  tenant_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  definition_digest TEXT NOT NULL,
  validated_by TEXT NOT NULL,
  evidence_ref TEXT NOT NULL CHECK(length(trim(evidence_ref)) > 0),
  validated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(tenant_id,revision_id),
  FOREIGN KEY(tenant_id,revision_id,definition_digest,validated_by)
    REFERENCES semantic_candidate_revisions(tenant_id,id,definition_digest,owner_id)
);

-- Also prevent INSERT OR REPLACE from replacing an existing primary key.
CREATE TRIGGER candidate_revision_no_replace BEFORE INSERT ON semantic_candidate_revisions
WHEN EXISTS (SELECT 1 FROM semantic_candidate_revisions WHERE tenant_id=NEW.tenant_id AND id=NEW.id)
BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER candidate_validation_no_replace BEFORE INSERT ON semantic_candidate_validations
WHEN EXISTS (SELECT 1 FROM semantic_candidate_validations WHERE tenant_id=NEW.tenant_id AND revision_id=NEW.revision_id)
BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER candidate_revision_no_update BEFORE UPDATE ON semantic_candidate_revisions
BEGIN SELECT RAISE(ABORT,'immutable candidate revision'); END;
CREATE TRIGGER candidate_revision_no_delete BEFORE DELETE ON semantic_candidate_revisions
BEGIN SELECT RAISE(ABORT,'immutable candidate revision'); END;
CREATE TRIGGER candidate_validation_no_update BEFORE UPDATE ON semantic_candidate_validations
BEGIN SELECT RAISE(ABORT,'immutable candidate validation'); END;
CREATE TRIGGER candidate_validation_no_delete BEFORE DELETE ON semantic_candidate_validations
BEGIN SELECT RAISE(ABORT,'immutable candidate validation'); END;
