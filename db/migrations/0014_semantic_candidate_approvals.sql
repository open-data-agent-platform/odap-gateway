-- An approval points to an immutable validation; validation alone is never approval.
CREATE UNIQUE INDEX candidate_validation_owner
  ON semantic_candidate_validations(tenant_id,revision_id,validated_by);
CREATE TABLE semantic_candidate_approvals (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL CHECK(length(trim(id)) > 0),
  revision_id TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  approved_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(tenant_id,id),
  UNIQUE(tenant_id,revision_id),
  FOREIGN KEY(tenant_id,revision_id,approved_by)
    REFERENCES semantic_candidate_validations(tenant_id,revision_id,validated_by)
);

CREATE TRIGGER candidate_approval_no_replace BEFORE INSERT ON semantic_candidate_approvals
WHEN EXISTS (SELECT 1 FROM semantic_candidate_approvals
  WHERE tenant_id=NEW.tenant_id AND (id=NEW.id OR revision_id=NEW.revision_id))
BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER candidate_approval_no_update BEFORE UPDATE ON semantic_candidate_approvals
BEGIN SELECT RAISE(ABORT,'immutable candidate approval'); END;
CREATE TRIGGER candidate_approval_no_delete BEFORE DELETE ON semantic_candidate_approvals
BEGIN SELECT RAISE(ABORT,'immutable candidate approval'); END;
