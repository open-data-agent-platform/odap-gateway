-- Trusted catalog input for publication. Never seed it from candidate content.
-- Dispatch configuration cannot bootstrap this check: it already requires a release.
CREATE TABLE semantic_source_heads (
  tenant_id TEXT NOT NULL REFERENCES control_tenants(id),
  target TEXT NOT NULL,
  project_id TEXT NOT NULL,
  dataset_id TEXT NOT NULL,
  table_id TEXT NOT NULL,
  source_revision TEXT NOT NULL,
  PRIMARY KEY(tenant_id,target)
);

CREATE TABLE semantic_release_promotions (
  tenant_id TEXT NOT NULL,
  approval_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  release_id TEXT NOT NULL,
  promoted_by TEXT NOT NULL,
  PRIMARY KEY(tenant_id,approval_id),
  UNIQUE(tenant_id,release_id),
  FOREIGN KEY(tenant_id,approval_id) REFERENCES semantic_candidate_approvals(tenant_id,id),
  FOREIGN KEY(tenant_id,release_id) REFERENCES semantic_releases(tenant_id,id)
);

CREATE TRIGGER promotion_no_replace BEFORE INSERT ON semantic_release_promotions
WHEN EXISTS (SELECT 1 FROM semantic_releases WHERE tenant_id=NEW.tenant_id AND id=NEW.release_id)
  OR EXISTS (SELECT 1 FROM semantic_release_promotions WHERE tenant_id=NEW.tenant_id AND approval_id=NEW.approval_id)
BEGIN SELECT RAISE(ABORT,'semantic promotion unavailable'); END;

CREATE TRIGGER promote_approved_revision AFTER INSERT ON semantic_release_promotions BEGIN
  INSERT INTO semantic_releases(tenant_id,id,payload,created_by)
  SELECT a.tenant_id,NEW.release_id,json_object(
    'definitionDigest',r.definition_digest,'id',NEW.release_id,'owner',r.owner_id,
    'schemaVersion','0.1','sourceRevision',s.source_revision,'state','released','tenantId',a.tenant_id),a.approved_by
  FROM semantic_candidate_approvals a
  JOIN semantic_candidate_revisions r ON r.tenant_id=a.tenant_id AND r.id=a.revision_id AND r.owner_id=a.approved_by
  JOIN control_memberships m ON m.tenant_id=a.tenant_id AND m.principal_id=a.approved_by
  JOIN semantic_source_heads s ON s.tenant_id=r.tenant_id AND s.target=json_extract(r.definition_json,'$.target')
    AND s.source_revision=json_extract(r.definition_json,'$.sourceRevision')
    AND s.project_id=json_extract(r.definition_json,'$.table.project')
    AND s.dataset_id=json_extract(r.definition_json,'$.table.dataset')
    AND s.table_id=json_extract(r.definition_json,'$.table.name')
  WHERE a.tenant_id=NEW.tenant_id AND a.id=NEW.approval_id AND r.id=NEW.revision_id
    AND a.approved_by=NEW.promoted_by AND m.active=1 AND m.role='owner';
  SELECT CASE WHEN changes()<>1 THEN RAISE(ABORT,'semantic promotion unavailable') END;
END;

CREATE TRIGGER promotion_no_update BEFORE UPDATE ON semantic_release_promotions
BEGIN SELECT RAISE(ABORT,'immutable semantic promotion'); END;
CREATE TRIGGER promotion_no_delete BEFORE DELETE ON semantic_release_promotions
BEGIN SELECT RAISE(ABORT,'immutable semantic promotion'); END;
-- UPDATE/DELETE are already blocked on releases. Also prevent SQLite REPLACE
-- from changing the bytes of a release that has a recorded review chain.
CREATE TRIGGER promoted_release_no_replace BEFORE INSERT ON semantic_releases
WHEN EXISTS (SELECT 1 FROM semantic_release_promotions p JOIN semantic_releases r
  ON r.tenant_id=p.tenant_id AND r.id=p.release_id WHERE p.tenant_id=NEW.tenant_id AND p.release_id=NEW.id)
BEGIN SELECT RAISE(ABORT,'immutable promoted release'); END;
