-- Intake only: a request is not an authorized contract or an execution intent.
CREATE TABLE contract_requests (
  tenant_id TEXT NOT NULL, principal_id TEXT NOT NULL, id TEXT NOT NULL,
  release_id TEXT NOT NULL, requested_agent_id TEXT NOT NULL, action_digest TEXT NOT NULL,
  requested_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(tenant_id,principal_id,id),
  FOREIGN KEY(tenant_id,principal_id) REFERENCES control_memberships(tenant_id,principal_id),
  FOREIGN KEY(tenant_id,release_id) REFERENCES semantic_release_promotions(tenant_id,release_id)
);
CREATE TRIGGER contract_request_no_update BEFORE UPDATE ON contract_requests
BEGIN SELECT RAISE(ABORT,'immutable contract request'); END;
CREATE TRIGGER contract_request_no_delete BEFORE DELETE ON contract_requests
BEGIN SELECT RAISE(ABORT,'immutable contract request'); END;
CREATE TRIGGER contract_request_no_replace BEFORE INSERT ON contract_requests
WHEN EXISTS (SELECT 1 FROM contract_requests WHERE tenant_id=NEW.tenant_id AND principal_id=NEW.principal_id AND id=NEW.id)
BEGIN SELECT RAISE(IGNORE); END;

-- Compilation and the final insert both read this view. Catalog rows are
-- mutable; the immutable historical release alone cannot establish eligibility.
CREATE VIEW requestable_metric_releases AS
SELECT p.tenant_id,p.release_id,s.payload,r.definition_json,h.project_id
FROM semantic_release_promotions p
JOIN semantic_releases s ON s.tenant_id=p.tenant_id AND s.id=p.release_id
JOIN semantic_candidate_revisions r ON r.tenant_id=p.tenant_id AND r.id=p.revision_id
JOIN semantic_source_heads h ON h.tenant_id=r.tenant_id AND h.target=json_extract(r.definition_json,'$.target')
  AND h.source_revision=json_extract(r.definition_json,'$.sourceRevision')
  AND h.project_id=json_extract(r.definition_json,'$.table.project')
  AND h.dataset_id=json_extract(r.definition_json,'$.table.dataset')
  AND h.table_id=json_extract(r.definition_json,'$.table.name')
WHERE json_extract(s.payload,'$.state')='released' AND json_extract(s.payload,'$.definitionDigest')=r.definition_digest
  AND NOT EXISTS (SELECT 1 FROM dispatch_retired_releases d WHERE d.tenant_id=p.tenant_id AND d.release_id=p.release_id);
