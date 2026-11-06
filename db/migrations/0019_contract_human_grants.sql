-- A human decision is not an issued contract or a budget reservation.
CREATE TABLE contract_human_grants (
  tenant_id TEXT NOT NULL, id TEXT NOT NULL, requester_id TEXT NOT NULL, request_id TEXT NOT NULL,
  granted_by TEXT NOT NULL, policy_revision TEXT NOT NULL, project_id TEXT NOT NULL, location TEXT NOT NULL,
  granted_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now','+10 minutes')),
  PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,requester_id,request_id),
  FOREIGN KEY(tenant_id,requester_id,request_id) REFERENCES contract_requests(tenant_id,principal_id,id),
  FOREIGN KEY(tenant_id,granted_by) REFERENCES control_memberships(tenant_id,principal_id),
  CHECK(requester_id<>granted_by)
);
CREATE TRIGGER human_grant_no_update BEFORE UPDATE ON contract_human_grants
BEGIN SELECT RAISE(ABORT,'immutable human grant'); END;
CREATE TRIGGER human_grant_no_delete BEFORE DELETE ON contract_human_grants
BEGIN SELECT RAISE(ABORT,'immutable human grant'); END;
CREATE TRIGGER human_grant_no_replace BEFORE INSERT ON contract_human_grants
WHEN EXISTS (SELECT 1 FROM contract_human_grants WHERE tenant_id=NEW.tenant_id AND
  (id=NEW.id OR (requester_id=NEW.requester_id AND request_id=NEW.request_id)))
BEGIN SELECT RAISE(IGNORE); END;

CREATE VIEW grantable_contract_requests AS
SELECT q.tenant_id,q.principal_id AS requester_id,q.id AS request_id,q.release_id,q.requested_agent_id,
  q.action_digest,o.principal_id AS owner_id,t.policy_revision,t.project_id,t.location
FROM contract_requests q
JOIN requestable_metric_releases e ON e.tenant_id=q.tenant_id AND e.release_id=q.release_id
JOIN control_memberships m ON m.tenant_id=q.tenant_id AND m.principal_id=q.principal_id AND m.active=1
JOIN control_memberships o ON o.tenant_id=q.tenant_id AND o.principal_id=json_extract(e.payload,'$.owner')
  AND o.active=1 AND o.role='owner' AND o.principal_id<>m.principal_id
JOIN dispatch_targets t ON t.tenant_id=q.tenant_id AND t.release_id=q.release_id
  AND t.target=json_extract(e.definition_json,'$.target') AND t.project_id=e.project_id
  AND t.source_revision=json_extract(e.payload,'$.sourceRevision')
JOIN dispatch_read_grants g ON g.tenant_id=t.tenant_id AND g.target=t.target AND g.policy_revision=t.policy_revision
  AND g.principal_id=q.principal_id AND g.agent_id=q.requested_agent_id;
