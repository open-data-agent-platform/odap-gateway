-- Explicit, short-lived requester consent. Existing session approvals stay unchanged.
CREATE TABLE postgresql_agent_delegations (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  requester_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  key_id TEXT NOT NULL,
  audience TEXT NOT NULL,
  expires_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now','+10 minutes')),
  revoked_at TEXT,
  PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,request_id),
  FOREIGN KEY(tenant_id,request_id) REFERENCES postgresql_read_requests(tenant_id,id),
  FOREIGN KEY(tenant_id,agent_id,key_id) REFERENCES agent_verification_keys(tenant_id,agent_id,key_id)
) WITHOUT ROWID;
CREATE TRIGGER postgresql_delegation_guard BEFORE INSERT ON postgresql_agent_delegations BEGIN
  SELECT RAISE(ABORT,'PostgreSQL delegation unavailable') WHERE NOT EXISTS(
    SELECT 1 FROM postgresql_current_requests q
    JOIN agent_verification_keys k ON k.tenant_id=q.tenant_id AND k.agent_id=NEW.agent_id AND k.key_id=NEW.key_id AND k.active=1
    WHERE q.tenant_id=NEW.tenant_id AND q.id=NEW.request_id AND q.requester_id=NEW.requester_id
      AND NOT EXISTS(SELECT 1 FROM postgresql_read_approvals a WHERE a.tenant_id=q.tenant_id AND a.request_id=q.id)
      AND NOT EXISTS(SELECT 1 FROM postgresql_read_stops s WHERE s.tenant_id=q.tenant_id AND s.request_id=q.id));
  SELECT RAISE(ABORT,'Invalid PostgreSQL delegation expiry') WHERE
    NEW.expires_at IS NOT strftime('%Y-%m-%dT%H:%M:%fZ','now','+10 minutes') OR NEW.revoked_at IS NOT NULL;
END;
CREATE TRIGGER postgresql_delegation_no_replace BEFORE INSERT ON postgresql_agent_delegations
WHEN EXISTS(SELECT 1 FROM postgresql_agent_delegations WHERE tenant_id=NEW.tenant_id AND (id=NEW.id OR request_id=NEW.request_id))
BEGIN SELECT RAISE(ABORT,'immutable PostgreSQL delegation'); END;
CREATE TRIGGER postgresql_delegation_revoke_only BEFORE UPDATE ON postgresql_agent_delegations
WHEN NOT (OLD.revoked_at IS NULL AND NEW.revoked_at IS strftime('%Y-%m-%dT%H:%M:%fZ','now')
  AND NEW.tenant_id=OLD.tenant_id AND NEW.id=OLD.id AND NEW.request_id=OLD.request_id AND NEW.requester_id=OLD.requester_id
  AND NEW.agent_id=OLD.agent_id AND NEW.key_id=OLD.key_id AND NEW.audience=OLD.audience AND NEW.expires_at=OLD.expires_at)
BEGIN SELECT RAISE(ABORT,'delegation can only be revoked'); END;
CREATE TRIGGER postgresql_delegation_no_delete BEFORE DELETE ON postgresql_agent_delegations
BEGIN SELECT RAISE(ABORT,'retain PostgreSQL delegation'); END;

ALTER TABLE postgresql_read_approvals ADD COLUMN delegation_id TEXT;
-- Composite reference is enforced below; SQLite cannot add a composite FK with ALTER.
CREATE TRIGGER postgresql_approval_delegation_guard BEFORE INSERT ON postgresql_read_approvals BEGIN
  SELECT RAISE(ABORT,'PostgreSQL delegation mismatch') WHERE
    (NEW.delegation_id IS NULL AND EXISTS(SELECT 1 FROM postgresql_agent_delegations d
      WHERE d.tenant_id=NEW.tenant_id AND d.request_id=NEW.request_id)) OR
    (NEW.delegation_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM postgresql_agent_delegations d
      JOIN agent_verification_keys k ON k.tenant_id=d.tenant_id AND k.agent_id=d.agent_id AND k.key_id=d.key_id AND k.active=1
      WHERE d.tenant_id=NEW.tenant_id AND d.request_id=NEW.request_id AND d.id=NEW.delegation_id
        AND d.revoked_at IS NULL AND julianday(d.expires_at)>julianday('now')));
END;

DROP TRIGGER postgresql_issue_contract;
CREATE TRIGGER postgresql_issue_contract AFTER INSERT ON postgresql_read_approvals BEGIN
  INSERT INTO approval_contracts(tenant_id,id,release_id,payload,created_by)
  SELECT q.tenant_id,NEW.contract_id,q.release_id,json_object(
    'schemaVersion','0.1','id',NEW.contract_id,'tenantId',q.tenant_id,'semanticReleaseId',q.release_id,
    'principalId',q.requester_id,'agentId',coalesce(d.agent_id,'postgresql-session'),'actionDigest',q.action_digest,
    'policyRevision',q.source_id,'sourceRevision',q.source_id,'target',q.target,'actionType','data.read',
    'authority',json_object('mode','human','reference',q.id),'reservationId',NEW.contract_id,
    'expiresAt',CASE WHEN d.id IS NULL THEN NEW.expires_at ELSE min(NEW.expires_at,d.expires_at) END,'state','authorized'),NEW.approved_by
  FROM postgresql_current_requests q LEFT JOIN postgresql_agent_delegations d
    ON d.tenant_id=q.tenant_id AND d.request_id=q.id AND d.id=NEW.delegation_id
  WHERE q.tenant_id=NEW.tenant_id AND q.id=NEW.request_id;
  SELECT CASE WHEN changes()<>1 THEN RAISE(ABORT,'PostgreSQL contract unavailable') END;
END;

DROP VIEW postgresql_claimable_reads;
CREATE VIEW postgresql_claimable_reads AS
SELECT q.*,a.contract_id,CASE WHEN d.id IS NULL THEN a.expires_at ELSE min(a.expires_at,d.expires_at) END AS expires_at,
  a.delegation_id,d.agent_id,d.key_id,d.audience,k.public_hex
FROM postgresql_current_requests q
JOIN postgresql_read_approvals a ON a.tenant_id=q.tenant_id AND a.request_id=q.id AND a.approved_by=q.owner_id
JOIN contract_lifecycle l ON l.tenant_id=a.tenant_id AND l.contract_id=a.contract_id AND l.state='authorized'
JOIN postgresql_read_budgets b ON b.tenant_id=q.tenant_id AND b.id=q.budget_id
LEFT JOIN postgresql_agent_delegations d ON d.tenant_id=q.tenant_id AND d.request_id=q.id AND d.id=a.delegation_id
LEFT JOIN agent_verification_keys k ON k.tenant_id=d.tenant_id AND k.agent_id=d.agent_id AND k.key_id=d.key_id
WHERE julianday(a.expires_at)>julianday('now')
  AND (a.delegation_id IS NULL OR (d.requester_id=q.requester_id AND d.revoked_at IS NULL AND k.active=1 AND julianday(d.expires_at)>julianday('now')))
  AND NOT EXISTS(SELECT 1 FROM postgresql_read_stops s WHERE s.tenant_id=q.tenant_id AND s.request_id=q.id)
  AND NOT EXISTS(SELECT 1 FROM postgresql_read_claims c WHERE c.tenant_id=q.tenant_id AND c.request_id=q.id)
  AND (SELECT count(*) FROM postgresql_read_claims c WHERE c.tenant_id=q.tenant_id AND c.budget_id=q.budget_id)<b.limit_attempts;

-- Immutable terms for signed read-only recovery, including after source/release retirement.
CREATE VIEW postgresql_agent_scopes AS
SELECT q.*,v.connection_digest,v.role_name,v.budget_id,v.target,
  json_extract(r.payload,'$.definitionDigest') AS definition_digest,a.contract_id,
  min(a.expires_at,d.expires_at) AS expires_at,d.id AS delegation_id,d.agent_id,d.key_id,d.audience,k.public_hex
FROM postgresql_read_requests q
JOIN postgresql_source_versions v ON v.tenant_id=q.tenant_id AND v.id=q.source_id
JOIN semantic_releases r ON r.tenant_id=q.tenant_id AND r.id=q.release_id
JOIN postgresql_read_approvals a ON a.tenant_id=q.tenant_id AND a.request_id=q.id
JOIN postgresql_agent_delegations d ON d.tenant_id=q.tenant_id AND d.request_id=q.id AND d.id=a.delegation_id AND d.requester_id=q.requester_id
JOIN agent_verification_keys k ON k.tenant_id=d.tenant_id AND k.agent_id=d.agent_id AND k.key_id=d.key_id
JOIN control_memberships m ON m.tenant_id=q.tenant_id AND m.principal_id=q.requester_id AND m.active=1
WHERE d.revoked_at IS NULL AND k.active=1 AND julianday(a.expires_at)>julianday('now') AND julianday(d.expires_at)>julianday('now');
