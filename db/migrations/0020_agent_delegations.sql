-- Operator-enrolled uncompressed P-256 public points. No self-enrollment or backfill.
CREATE TABLE agent_verification_keys (
  tenant_id TEXT NOT NULL REFERENCES control_tenants(id), agent_id TEXT NOT NULL, key_id TEXT NOT NULL,
  public_hex TEXT NOT NULL CHECK(length(public_hex)=130 AND substr(public_hex,1,2)='04' AND public_hex NOT GLOB '*[^0-9a-f]*'),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  PRIMARY KEY(tenant_id,agent_id,key_id), UNIQUE(tenant_id,public_hex)
);
CREATE TRIGGER agent_key_no_replace BEFORE INSERT ON agent_verification_keys
WHEN EXISTS (SELECT 1 FROM agent_verification_keys WHERE tenant_id=NEW.tenant_id AND
  ((agent_id=NEW.agent_id AND key_id=NEW.key_id) OR public_hex=NEW.public_hex))
BEGIN SELECT RAISE(ABORT,'key already enrolled'); END;
CREATE TRIGGER agent_key_disable_only BEFORE UPDATE ON agent_verification_keys
WHEN NOT (OLD.active=1 AND NEW.active=0 AND OLD.tenant_id=NEW.tenant_id AND OLD.agent_id=NEW.agent_id
  AND OLD.key_id=NEW.key_id AND OLD.public_hex=NEW.public_hex)
BEGIN SELECT RAISE(ABORT,'key can only be disabled'); END;
CREATE TRIGGER agent_key_no_delete BEFORE DELETE ON agent_verification_keys
BEGIN SELECT RAISE(ABORT,'retain key history'); END;

CREATE TABLE agent_delegations (
  tenant_id TEXT NOT NULL,id TEXT NOT NULL,grant_id TEXT NOT NULL,audience TEXT NOT NULL,
  agent_id TEXT NOT NULL,key_id TEXT NOT NULL,revoked_at TEXT,
  PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,grant_id),
  FOREIGN KEY(tenant_id,grant_id) REFERENCES contract_human_grants(tenant_id,id),
  FOREIGN KEY(tenant_id,agent_id,key_id) REFERENCES agent_verification_keys(tenant_id,agent_id,key_id)
);
CREATE TRIGGER delegation_no_replace BEFORE INSERT ON agent_delegations
WHEN EXISTS (SELECT 1 FROM agent_delegations WHERE tenant_id=NEW.tenant_id AND (id=NEW.id OR grant_id=NEW.grant_id))
BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER delegation_revoke_only BEFORE UPDATE ON agent_delegations
WHEN NOT (OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL AND OLD.tenant_id=NEW.tenant_id AND OLD.id=NEW.id
  AND OLD.grant_id=NEW.grant_id AND OLD.audience=NEW.audience AND OLD.agent_id=NEW.agent_id AND OLD.key_id=NEW.key_id)
BEGIN SELECT RAISE(ABORT,'delegation can only be revoked'); END;
CREATE TRIGGER delegation_no_delete BEFORE DELETE ON agent_delegations
BEGIN SELECT RAISE(ABORT,'retain delegation history'); END;

CREATE VIEW current_delegable_grants AS
SELECT e.*,g.id AS grant_id,g.expires_at FROM contract_human_grants g JOIN grantable_contract_requests e
  ON e.tenant_id=g.tenant_id AND e.requester_id=g.requester_id AND e.request_id=g.request_id AND e.owner_id=g.granted_by
  AND e.policy_revision=g.policy_revision AND e.project_id=g.project_id AND e.location=g.location
WHERE julianday(g.expires_at)>julianday('now');
CREATE VIEW current_agent_delegations AS
SELECT g.*,d.id AS delegation_id,d.audience,d.key_id,k.public_hex FROM agent_delegations d
JOIN current_delegable_grants g ON g.tenant_id=d.tenant_id AND g.grant_id=d.grant_id AND g.requested_agent_id=d.agent_id
JOIN agent_verification_keys k ON k.tenant_id=d.tenant_id AND k.agent_id=d.agent_id AND k.key_id=d.key_id
WHERE d.revoked_at IS NULL AND k.active=1;

CREATE TABLE agent_delegation_proofs (
  tenant_id TEXT NOT NULL,delegation_id TEXT NOT NULL,verified_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(tenant_id,delegation_id), FOREIGN KEY(tenant_id,delegation_id) REFERENCES agent_delegations(tenant_id,id)
);
CREATE TRIGGER delegation_proof_no_replace BEFORE INSERT ON agent_delegation_proofs
WHEN EXISTS (SELECT 1 FROM agent_delegation_proofs WHERE tenant_id=NEW.tenant_id AND delegation_id=NEW.delegation_id)
BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER delegation_proof_no_update BEFORE UPDATE ON agent_delegation_proofs
BEGIN SELECT RAISE(ABORT,'immutable proof'); END;
CREATE TRIGGER delegation_proof_no_delete BEFORE DELETE ON agent_delegation_proofs
BEGIN SELECT RAISE(ABORT,'immutable proof'); END;
