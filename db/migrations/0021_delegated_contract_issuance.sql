-- Proof is historical; the delegation view supplies the current authority.
CREATE VIEW issuable_delegations AS
SELECT d.tenant_id,d.audience,d.delegation_id,d.requester_id,d.requested_agent_id,
  d.release_id,d.action_digest,d.policy_revision,d.grant_id,d.expires_at,
  json_extract(r.definition_json,'$.target') AS target,
  json_extract(r.definition_json,'$.sourceRevision') AS source_revision
FROM current_agent_delegations d JOIN agent_delegation_proofs p
  ON p.tenant_id=d.tenant_id AND p.delegation_id=d.delegation_id
JOIN semantic_release_promotions s ON s.tenant_id=d.tenant_id AND s.release_id=d.release_id
JOIN semantic_candidate_revisions r ON r.tenant_id=s.tenant_id AND r.id=s.revision_id;

CREATE TABLE delegated_contract_issuances (
  tenant_id TEXT NOT NULL, delegation_id TEXT NOT NULL, audience TEXT NOT NULL,
  requested_by TEXT NOT NULL, contract_id TEXT NOT NULL, reservation_id TEXT NOT NULL,
  PRIMARY KEY(tenant_id,delegation_id), UNIQUE(tenant_id,contract_id), UNIQUE(tenant_id,reservation_id),
  FOREIGN KEY(tenant_id,delegation_id) REFERENCES agent_delegation_proofs(tenant_id,delegation_id),
  FOREIGN KEY(tenant_id,contract_id) REFERENCES approval_contracts(tenant_id,id)
);
CREATE TRIGGER issuance_no_replace BEFORE INSERT ON delegated_contract_issuances
WHEN EXISTS (SELECT 1 FROM delegated_contract_issuances WHERE tenant_id=NEW.tenant_id AND
  (delegation_id=NEW.delegation_id OR contract_id=NEW.contract_id OR reservation_id=NEW.reservation_id))
  OR EXISTS (SELECT 1 FROM approval_contracts WHERE tenant_id=NEW.tenant_id AND id=NEW.contract_id)
BEGIN SELECT RAISE(ABORT,'issuance ID conflict'); END;
CREATE TRIGGER issuance_no_update BEFORE UPDATE ON delegated_contract_issuances
BEGIN SELECT RAISE(ABORT,'immutable issuance'); END;
CREATE TRIGGER issuance_no_delete BEFORE DELETE ON delegated_contract_issuances
BEGIN SELECT RAISE(ABORT,'immutable issuance'); END;

-- The existing contract insert triggers create its lifecycle and audit events.
-- All of them roll back with the issuance if any write fails.
CREATE TRIGGER issue_delegated_contract AFTER INSERT ON delegated_contract_issuances BEGIN
  INSERT INTO approval_contracts(tenant_id,id,release_id,payload,created_by)
  SELECT d.tenant_id,NEW.contract_id,d.release_id,json_object(
    'schemaVersion','0.1','id',NEW.contract_id,'tenantId',d.tenant_id,'semanticReleaseId',d.release_id,
    'principalId',d.requester_id,'agentId',d.requested_agent_id,'actionDigest',d.action_digest,
    'policyRevision',d.policy_revision,'sourceRevision',d.source_revision,'target',d.target,'actionType','data.read',
    'authority',json_object('mode','human','reference',d.grant_id),'reservationId',NEW.reservation_id,
    'expiresAt',d.expires_at,'state','authorized'),d.requester_id
  FROM issuable_delegations d WHERE d.tenant_id=NEW.tenant_id AND d.audience=NEW.audience
    AND d.delegation_id=NEW.delegation_id AND d.requester_id=NEW.requested_by;
  SELECT CASE WHEN changes()<>1 THEN RAISE(ABORT,'delegation no longer eligible') END;
END;
CREATE TRIGGER issued_contract_no_replace BEFORE INSERT ON approval_contracts
WHEN EXISTS (SELECT 1 FROM delegated_contract_issuances i JOIN approval_contracts c
  ON c.tenant_id=i.tenant_id AND c.id=i.contract_id WHERE i.tenant_id=NEW.tenant_id AND i.contract_id=NEW.id)
BEGIN SELECT RAISE(ABORT,'immutable issued contract'); END;
CREATE TRIGGER issued_lifecycle_no_replace BEFORE INSERT ON contract_lifecycle
WHEN EXISTS (SELECT 1 FROM delegated_contract_issuances i JOIN contract_lifecycle l
  ON l.tenant_id=i.tenant_id AND l.contract_id=i.contract_id WHERE i.tenant_id=NEW.tenant_id AND i.contract_id=NEW.contract_id)
BEGIN SELECT RAISE(ABORT,'immutable issued lifecycle'); END;

-- Issuance allocates an identifier, not budget. Legacy consumption/admission
-- must not spend this contract before there is a delegation-aware budget gate.
CREATE TRIGGER issued_contract_hold BEFORE UPDATE ON contract_lifecycle
WHEN NEW.state='consumed' AND EXISTS (SELECT 1 FROM delegated_contract_issuances
  WHERE tenant_id=OLD.tenant_id AND contract_id=OLD.contract_id)
BEGIN SELECT RAISE(ABORT,'delegated admission required'); END;
CREATE TRIGGER issued_intent_hold BEFORE INSERT ON execution_intents
WHEN EXISTS (SELECT 1 FROM delegated_contract_issuances WHERE tenant_id=NEW.tenant_id AND contract_id=NEW.contract_id)
BEGIN SELECT RAISE(ABORT,'delegated admission required'); END;
