-- Operator-managed current authority. No permissive backfill from historical contracts.
CREATE TABLE dispatch_targets (
  tenant_id TEXT NOT NULL, target TEXT NOT NULL, release_id TEXT NOT NULL,
  policy_revision TEXT NOT NULL, source_revision TEXT NOT NULL,
  project_id TEXT NOT NULL, location TEXT NOT NULL,
  PRIMARY KEY(tenant_id,target),
  FOREIGN KEY(tenant_id,release_id) REFERENCES semantic_releases(tenant_id,id)
);
CREATE TABLE dispatch_read_grants (
  tenant_id TEXT NOT NULL, target TEXT NOT NULL, principal_id TEXT NOT NULL,
  agent_id TEXT NOT NULL, policy_revision TEXT NOT NULL,
  PRIMARY KEY(tenant_id,target,principal_id,agent_id,policy_revision),
  FOREIGN KEY(tenant_id,target) REFERENCES dispatch_targets(tenant_id,target),
  FOREIGN KEY(tenant_id,principal_id) REFERENCES control_memberships(tenant_id,principal_id)
);
CREATE TABLE dispatch_retired_releases (
  tenant_id TEXT NOT NULL, release_id TEXT NOT NULL, reason TEXT NOT NULL CHECK(length(trim(reason))>0),
  PRIMARY KEY(tenant_id,release_id),
  FOREIGN KEY(tenant_id,release_id) REFERENCES semantic_releases(tenant_id,id)
);
CREATE TABLE dispatch_stopped_intents (
  tenant_id TEXT NOT NULL, intent_id TEXT NOT NULL, reason TEXT NOT NULL CHECK(length(trim(reason))>0),
  PRIMARY KEY(tenant_id,intent_id),
  FOREIGN KEY(tenant_id,intent_id) REFERENCES execution_intents(tenant_id,id)
);

CREATE TABLE dispatch_claims (
  tenant_id TEXT NOT NULL, intent_id TEXT NOT NULL, claimed_by TEXT NOT NULL,
  claimed_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(tenant_id,intent_id),
  FOREIGN KEY(tenant_id,intent_id) REFERENCES bigquery_job_bindings(tenant_id,intent_id)
);
CREATE TRIGGER dispatch_claim_no_delete BEFORE DELETE ON dispatch_claims
BEGIN SELECT RAISE(ABORT,'immutable dispatch claim'); END;
CREATE TRIGGER dispatch_claim_no_update BEFORE UPDATE ON dispatch_claims
BEGIN SELECT RAISE(ABORT,'immutable dispatch claim'); END;

-- This view is evaluated again in the final conditional write, not cached.
CREATE VIEW dispatch_eligible_reads AS
SELECT i.tenant_id,i.id AS intent_id,i.principal_id,g.agent_id,t.target,i.action_digest,
       b.project_id,b.location,b.job_id,b.action_tag,b.receipt_id,
       c.payload AS contract_payload,r.payload AS release_payload
FROM execution_intents i
JOIN approval_contracts c ON c.tenant_id=i.tenant_id AND c.id=i.contract_id
JOIN contract_lifecycle l ON l.tenant_id=i.tenant_id AND l.contract_id=c.id AND l.state='consumed'
JOIN semantic_releases r ON r.tenant_id=i.tenant_id AND r.id=c.release_id
JOIN control_memberships m ON m.tenant_id=i.tenant_id AND m.principal_id=i.principal_id AND m.active=1
JOIN bigquery_job_bindings b ON b.tenant_id=i.tenant_id AND b.intent_id=i.id
JOIN dispatch_targets t ON t.tenant_id=i.tenant_id AND t.target=json_extract(c.payload,'$.target')
  AND t.release_id=r.id AND t.project_id=b.project_id AND t.location=b.location
  AND t.policy_revision=json_extract(c.payload,'$.policyRevision')
  AND t.source_revision=json_extract(c.payload,'$.sourceRevision')
  AND t.source_revision=json_extract(r.payload,'$.sourceRevision')
JOIN dispatch_read_grants g ON g.tenant_id=t.tenant_id AND g.target=t.target
  AND g.policy_revision=t.policy_revision AND g.principal_id=i.principal_id AND g.agent_id=json_extract(c.payload,'$.agentId')
JOIN control_budgets budget ON budget.tenant_id=i.tenant_id AND budget.id=i.budget_id
WHERE json_extract(c.payload,'$.state')='authorized' AND json_extract(c.payload,'$.actionType')='data.read'
  AND json_extract(c.payload,'$.principalId')=i.principal_id AND json_extract(c.payload,'$.actionDigest')=i.action_digest
  AND json_extract(c.payload,'$.reservationId')=i.reservation_id AND json_extract(r.payload,'$.state')='released'
  AND julianday(json_extract(c.payload,'$.expiresAt')) > julianday('now')
  AND budget.overrun_units=0 AND budget.reserved_units>=i.reserved_units
  AND NOT EXISTS(SELECT 1 FROM cost_settlements WHERE tenant_id=i.tenant_id AND intent_id=i.id)
  AND NOT EXISTS(SELECT 1 FROM dispatch_retired_releases WHERE tenant_id=i.tenant_id AND release_id=r.id)
  AND NOT EXISTS(SELECT 1 FROM dispatch_stopped_intents WHERE tenant_id=i.tenant_id AND intent_id=i.id);
