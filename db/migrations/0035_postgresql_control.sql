-- Opt-in host control plane. No source, role, quota or release is backfilled.
-- Read-attempt quotas are not monetary prices; uncertain submissions consume one.
CREATE TABLE postgresql_read_budgets (
  tenant_id TEXT NOT NULL REFERENCES control_tenants(id),
  id TEXT NOT NULL,
  limit_attempts INTEGER NOT NULL CHECK(typeof(limit_attempts)='integer' AND limit_attempts BETWEEN 1 AND 1000000),
  PRIMARY KEY(tenant_id,id)
) WITHOUT ROWID;
CREATE TABLE postgresql_source_versions (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  target TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  connection_ref TEXT NOT NULL,
  connection_digest TEXT NOT NULL CHECK(length(connection_digest)=71 AND connection_digest LIKE 'sha256:%'),
  source_json TEXT NOT NULL CHECK(json_valid(source_json)),
  role_name TEXT NOT NULL,
  budget_id TEXT NOT NULL,
  valid_until TEXT NOT NULL,
  PRIMARY KEY(tenant_id,id),
  UNIQUE(tenant_id,target,id),
  FOREIGN KEY(tenant_id,owner_id) REFERENCES control_memberships(tenant_id,principal_id),
  FOREIGN KEY(tenant_id,budget_id) REFERENCES postgresql_read_budgets(tenant_id,id)
) WITHOUT ROWID;
-- Trusted operator catalog only, never populated from a request or CLI identity.
CREATE TABLE postgresql_source_heads (
  tenant_id TEXT NOT NULL,
  target TEXT NOT NULL,
  source_id TEXT NOT NULL,
  active INTEGER NOT NULL CHECK(active IN (0,1)),
  PRIMARY KEY(tenant_id,target),
  FOREIGN KEY(tenant_id,target,source_id) REFERENCES postgresql_source_versions(tenant_id,target,id)
) WITHOUT ROWID;
CREATE VIEW postgresql_current_sources AS
SELECT s.* FROM postgresql_source_versions s
JOIN postgresql_source_heads h ON h.tenant_id=s.tenant_id AND h.target=s.target AND h.source_id=s.id AND h.active=1
JOIN control_memberships m ON m.tenant_id=s.tenant_id AND m.principal_id=s.owner_id AND m.active=1 AND m.role='owner'
WHERE julianday(s.valid_until)>julianday('now');

-- Preserve the BigQuery publication branch and add a separately bound PG branch.
DROP TRIGGER promote_approved_revision;
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
    AND a.approved_by=NEW.promoted_by AND m.active=1 AND m.role='owner'
  UNION ALL
  SELECT a.tenant_id,NEW.release_id,json_object(
    'definitionDigest',r.definition_digest,'id',NEW.release_id,'owner',r.owner_id,
    'schemaVersion','0.1','sourceRevision',s.id,'state','released','tenantId',a.tenant_id),a.approved_by
  FROM semantic_candidate_approvals a
  JOIN semantic_candidate_revisions r ON r.tenant_id=a.tenant_id AND r.id=a.revision_id AND r.owner_id=a.approved_by
  JOIN postgresql_current_sources s ON s.tenant_id=r.tenant_id AND s.owner_id=r.owner_id
    AND s.id=json_extract(r.definition_json,'$.sourceRevision') AND s.target=json_extract(r.definition_json,'$.target')
    AND json_extract(s.source_json,'$.database')=json_extract(r.definition_json,'$.table.database')
    AND json_extract(s.source_json,'$.schema')=json_extract(r.definition_json,'$.table.schema')
    AND json_extract(s.source_json,'$.table')=json_extract(r.definition_json,'$.table.name')
    AND json_extract(s.source_json,'$.tenantColumn')=json_extract(r.definition_json,'$.table.tenantColumn')
  WHERE a.tenant_id=NEW.tenant_id AND a.id=NEW.approval_id AND r.id=NEW.revision_id
    AND a.approved_by=NEW.promoted_by AND json_extract(r.definition_json,'$.profile')='odap.postgresql-metric.v1';
  SELECT CASE WHEN changes()<>1 THEN RAISE(ABORT,'semantic promotion unavailable') END;
END;

CREATE VIEW postgresql_available_releases AS
SELECT s.*,r.id AS release_id,r.payload AS release_json,v.definition_json,v.definition_digest
FROM postgresql_current_sources s
JOIN semantic_releases r ON r.tenant_id=s.tenant_id AND json_extract(r.payload,'$.sourceRevision')=s.id
  AND json_extract(r.payload,'$.owner')=s.owner_id AND json_extract(r.payload,'$.state')='released'
JOIN semantic_release_promotions p ON p.tenant_id=r.tenant_id AND p.release_id=r.id
JOIN semantic_candidate_revisions v ON v.tenant_id=p.tenant_id AND v.id=p.revision_id
  AND v.definition_digest=json_extract(r.payload,'$.definitionDigest')
  AND json_extract(v.definition_json,'$.profile')='odap.postgresql-metric.v1'
  AND json_extract(v.definition_json,'$.target')=s.target
WHERE NOT EXISTS(SELECT 1 FROM dispatch_retired_releases d WHERE d.tenant_id=r.tenant_id AND d.release_id=r.id);

CREATE TABLE postgresql_read_requests (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  requester_id TEXT NOT NULL,
  release_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  action_json TEXT NOT NULL CHECK(json_valid(action_json)),
  action_digest TEXT NOT NULL,
  statement_digest TEXT NOT NULL,
  requested_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(tenant_id,id),
  FOREIGN KEY(tenant_id,requester_id) REFERENCES control_memberships(tenant_id,principal_id),
  FOREIGN KEY(tenant_id,release_id) REFERENCES semantic_releases(tenant_id,id),
  FOREIGN KEY(tenant_id,source_id) REFERENCES postgresql_source_versions(tenant_id,id)
) WITHOUT ROWID;
CREATE VIEW postgresql_current_requests AS
SELECT q.*,r.owner_id,r.connection_ref,r.connection_digest,r.source_json,r.role_name,r.target,r.budget_id,
  r.release_json,r.definition_json,r.definition_digest
FROM postgresql_read_requests q
JOIN postgresql_available_releases r ON r.tenant_id=q.tenant_id AND r.release_id=q.release_id AND r.id=q.source_id
JOIN control_memberships m ON m.tenant_id=q.tenant_id AND m.principal_id=q.requester_id AND m.active=1;

CREATE TABLE postgresql_read_approvals (
  tenant_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  contract_id TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  expires_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now','+10 minutes')),
  PRIMARY KEY(tenant_id,request_id),
  UNIQUE(tenant_id,contract_id),
  FOREIGN KEY(tenant_id,request_id) REFERENCES postgresql_read_requests(tenant_id,id),
  FOREIGN KEY(tenant_id,contract_id) REFERENCES approval_contracts(tenant_id,id)
) WITHOUT ROWID;
CREATE TRIGGER postgresql_approval_guard BEFORE INSERT ON postgresql_read_approvals BEGIN
  SELECT RAISE(ABORT,'PostgreSQL approval unavailable') WHERE NOT EXISTS(
    SELECT 1 FROM postgresql_current_requests q WHERE q.tenant_id=NEW.tenant_id AND q.id=NEW.request_id
      AND q.owner_id=NEW.approved_by AND q.requester_id<>NEW.approved_by);
  SELECT RAISE(ABORT,'Invalid PostgreSQL expiry') WHERE NEW.expires_at IS NOT strftime('%Y-%m-%dT%H:%M:%fZ','now','+10 minutes');
END;
CREATE TRIGGER postgresql_issue_contract AFTER INSERT ON postgresql_read_approvals BEGIN
  INSERT INTO approval_contracts(tenant_id,id,release_id,payload,created_by)
  SELECT q.tenant_id,NEW.contract_id,q.release_id,json_object(
    'schemaVersion','0.1','id',NEW.contract_id,'tenantId',q.tenant_id,'semanticReleaseId',q.release_id,
    'principalId',q.requester_id,'agentId','postgresql-session','actionDigest',q.action_digest,
    'policyRevision',q.source_id,'sourceRevision',q.source_id,'target',q.target,'actionType','data.read',
    'authority',json_object('mode','human','reference',q.id),'reservationId',NEW.contract_id,
    'expiresAt',NEW.expires_at,'state','authorized'),NEW.approved_by
  FROM postgresql_current_requests q WHERE q.tenant_id=NEW.tenant_id AND q.id=NEW.request_id;
  SELECT CASE WHEN changes()<>1 THEN RAISE(ABORT,'PostgreSQL contract unavailable') END;
END;

CREATE TABLE postgresql_read_stops (
  tenant_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  stopped_by TEXT NOT NULL,
  stopped_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(tenant_id,request_id),
  FOREIGN KEY(tenant_id,request_id) REFERENCES postgresql_read_requests(tenant_id,id)
) WITHOUT ROWID;
CREATE TABLE postgresql_read_claims (
  tenant_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  intent_id TEXT NOT NULL,
  claimed_by TEXT NOT NULL,
  budget_id TEXT NOT NULL,
  statement_digest TEXT NOT NULL,
  claimed_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(tenant_id,request_id),
  UNIQUE(tenant_id,intent_id),
  FOREIGN KEY(tenant_id,request_id) REFERENCES postgresql_read_approvals(tenant_id,request_id),
  FOREIGN KEY(tenant_id,budget_id) REFERENCES postgresql_read_budgets(tenant_id,id)
) WITHOUT ROWID;
CREATE VIEW postgresql_claimable_reads AS
SELECT q.*,a.contract_id,a.expires_at FROM postgresql_current_requests q
JOIN postgresql_read_approvals a ON a.tenant_id=q.tenant_id AND a.request_id=q.id AND a.approved_by=q.owner_id
JOIN contract_lifecycle l ON l.tenant_id=a.tenant_id AND l.contract_id=a.contract_id AND l.state='authorized'
JOIN postgresql_read_budgets b ON b.tenant_id=q.tenant_id AND b.id=q.budget_id
WHERE julianday(a.expires_at)>julianday('now')
  AND NOT EXISTS(SELECT 1 FROM postgresql_read_stops s WHERE s.tenant_id=q.tenant_id AND s.request_id=q.id)
  AND NOT EXISTS(SELECT 1 FROM postgresql_read_claims c WHERE c.tenant_id=q.tenant_id AND c.request_id=q.id)
  AND (SELECT count(*) FROM postgresql_read_claims c WHERE c.tenant_id=q.tenant_id AND c.budget_id=q.budget_id)<b.limit_attempts;
CREATE INDEX postgresql_claim_budget ON postgresql_read_claims(tenant_id,budget_id);
CREATE TRIGGER postgresql_claim_guard BEFORE INSERT ON postgresql_read_claims BEGIN
  SELECT RAISE(ABORT,'PostgreSQL claim unavailable') WHERE NOT EXISTS(
    SELECT 1 FROM postgresql_claimable_reads q WHERE q.tenant_id=NEW.tenant_id AND q.id=NEW.request_id
      AND q.requester_id=NEW.claimed_by AND q.budget_id=NEW.budget_id AND q.statement_digest=NEW.statement_digest);
END;
CREATE TRIGGER postgresql_claim_effects AFTER INSERT ON postgresql_read_claims BEGIN
  UPDATE contract_lifecycle SET state='consumed',changed_by=NEW.claimed_by,reason='PostgreSQL read attempt claimed'
  WHERE tenant_id=NEW.tenant_id AND contract_id=(SELECT contract_id FROM postgresql_read_approvals
    WHERE tenant_id=NEW.tenant_id AND request_id=NEW.request_id) AND state='authorized';
  SELECT CASE WHEN changes()<>1 THEN RAISE(ABORT,'PostgreSQL contract unavailable') END;
  INSERT INTO evidence_receipts(tenant_id,id,release_id,contract_id,payload,created_by)
  SELECT q.tenant_id,'pg-pending-'||NEW.intent_id,q.release_id,a.contract_id,json_object(
    'schemaVersion','0.1','id','pg-pending-'||NEW.intent_id,'tenantId',q.tenant_id,'intentId',NEW.intent_id,
    'contractId',a.contract_id,'semanticReleaseId',q.release_id,'outcome','pending',
    'reason','postgresql_claimed_observation_required','recordedAt',strftime('%Y-%m-%dT%H:%M:%fZ','now')),NEW.claimed_by
  FROM postgresql_read_requests q JOIN postgresql_read_approvals a ON a.tenant_id=q.tenant_id AND a.request_id=q.id
  WHERE q.tenant_id=NEW.tenant_id AND q.id=NEW.request_id;
  SELECT CASE WHEN changes()<>1 THEN RAISE(ABORT,'PostgreSQL receipt unavailable') END;
END;
CREATE TABLE postgresql_read_observations (
  tenant_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  intent_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('succeeded','observation-required')),
  observed_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(tenant_id,request_id),
  FOREIGN KEY(tenant_id,request_id) REFERENCES postgresql_read_claims(tenant_id,request_id),
  FOREIGN KEY(tenant_id,intent_id) REFERENCES postgresql_read_claims(tenant_id,intent_id)
) WITHOUT ROWID;
CREATE TRIGGER postgresql_observation_guard BEFORE INSERT ON postgresql_read_observations BEGIN
  SELECT RAISE(ABORT,'PostgreSQL observation unavailable') WHERE NOT EXISTS(
    SELECT 1 FROM postgresql_read_claims c WHERE c.tenant_id=NEW.tenant_id AND c.request_id=NEW.request_id AND c.intent_id=NEW.intent_id);
END;
CREATE TRIGGER postgresql_observation_receipt AFTER INSERT ON postgresql_read_observations BEGIN
  INSERT INTO evidence_receipts(tenant_id,id,release_id,contract_id,payload,created_by)
  SELECT q.tenant_id,'pg-observed-'||NEW.intent_id,q.release_id,a.contract_id,json_object(
    'schemaVersion','0.1','id','pg-observed-'||NEW.intent_id,'tenantId',q.tenant_id,'intentId',NEW.intent_id,
    'contractId',a.contract_id,'semanticReleaseId',q.release_id,
    'outcome',CASE WHEN NEW.outcome='succeeded' THEN 'succeeded' ELSE 'pending' END,
    'reason',CASE WHEN NEW.outcome='succeeded' THEN 'postgresql_read_acknowledged' ELSE 'postgresql_execution_unconfirmed' END,
    'recordedAt',strftime('%Y-%m-%dT%H:%M:%fZ','now')),c.claimed_by
  FROM postgresql_read_requests q JOIN postgresql_read_approvals a ON a.tenant_id=q.tenant_id AND a.request_id=q.id
  JOIN postgresql_read_claims c ON c.tenant_id=q.tenant_id AND c.request_id=q.id
  WHERE q.tenant_id=NEW.tenant_id AND q.id=NEW.request_id;
  SELECT CASE WHEN changes()<>1 THEN RAISE(ABORT,'PostgreSQL observation unavailable') END;
END;

CREATE TRIGGER postgresql_budget_no_update BEFORE UPDATE ON postgresql_read_budgets BEGIN SELECT RAISE(ABORT,'immutable PostgreSQL budget'); END;
CREATE TRIGGER postgresql_budget_no_delete BEFORE DELETE ON postgresql_read_budgets BEGIN SELECT RAISE(ABORT,'immutable PostgreSQL budget'); END;
CREATE TRIGGER postgresql_budget_no_replace BEFORE INSERT ON postgresql_read_budgets
WHEN EXISTS(SELECT 1 FROM postgresql_read_budgets WHERE tenant_id=NEW.tenant_id AND id=NEW.id)
BEGIN SELECT RAISE(ABORT,'immutable PostgreSQL budget'); END;
CREATE TRIGGER postgresql_source_no_update BEFORE UPDATE ON postgresql_source_versions BEGIN SELECT RAISE(ABORT,'immutable PostgreSQL source'); END;
CREATE TRIGGER postgresql_source_no_delete BEFORE DELETE ON postgresql_source_versions BEGIN SELECT RAISE(ABORT,'immutable PostgreSQL source'); END;
CREATE TRIGGER postgresql_source_no_replace BEFORE INSERT ON postgresql_source_versions
WHEN EXISTS(SELECT 1 FROM postgresql_source_versions WHERE tenant_id=NEW.tenant_id AND id=NEW.id)
BEGIN SELECT RAISE(ABORT,'immutable PostgreSQL source'); END;
CREATE TRIGGER postgresql_request_no_update BEFORE UPDATE ON postgresql_read_requests BEGIN SELECT RAISE(ABORT,'immutable PostgreSQL request'); END;
CREATE TRIGGER postgresql_request_no_delete BEFORE DELETE ON postgresql_read_requests BEGIN SELECT RAISE(ABORT,'immutable PostgreSQL request'); END;
CREATE TRIGGER postgresql_request_no_replace BEFORE INSERT ON postgresql_read_requests
WHEN EXISTS(SELECT 1 FROM postgresql_read_requests WHERE tenant_id=NEW.tenant_id AND id=NEW.id)
BEGIN SELECT RAISE(ABORT,'immutable PostgreSQL request'); END;
CREATE TRIGGER postgresql_approval_no_update BEFORE UPDATE ON postgresql_read_approvals BEGIN SELECT RAISE(ABORT,'immutable PostgreSQL approval'); END;
CREATE TRIGGER postgresql_approval_no_delete BEFORE DELETE ON postgresql_read_approvals BEGIN SELECT RAISE(ABORT,'immutable PostgreSQL approval'); END;
CREATE TRIGGER postgresql_approval_no_replace BEFORE INSERT ON postgresql_read_approvals
WHEN EXISTS(SELECT 1 FROM postgresql_read_approvals WHERE tenant_id=NEW.tenant_id AND (request_id=NEW.request_id OR contract_id=NEW.contract_id))
BEGIN SELECT RAISE(ABORT,'immutable PostgreSQL approval'); END;
CREATE TRIGGER postgresql_stop_no_update BEFORE UPDATE ON postgresql_read_stops BEGIN SELECT RAISE(ABORT,'immutable PostgreSQL stop'); END;
CREATE TRIGGER postgresql_stop_no_delete BEFORE DELETE ON postgresql_read_stops BEGIN SELECT RAISE(ABORT,'immutable PostgreSQL stop'); END;
CREATE TRIGGER postgresql_stop_no_replace BEFORE INSERT ON postgresql_read_stops
WHEN EXISTS(SELECT 1 FROM postgresql_read_stops WHERE tenant_id=NEW.tenant_id AND request_id=NEW.request_id)
BEGIN SELECT RAISE(ABORT,'immutable PostgreSQL stop'); END;
CREATE TRIGGER postgresql_claim_no_update BEFORE UPDATE ON postgresql_read_claims BEGIN SELECT RAISE(ABORT,'immutable PostgreSQL claim'); END;
CREATE TRIGGER postgresql_claim_no_delete BEFORE DELETE ON postgresql_read_claims BEGIN SELECT RAISE(ABORT,'immutable PostgreSQL claim'); END;
CREATE TRIGGER postgresql_claim_no_replace BEFORE INSERT ON postgresql_read_claims
WHEN EXISTS(SELECT 1 FROM postgresql_read_claims WHERE tenant_id=NEW.tenant_id AND (request_id=NEW.request_id OR intent_id=NEW.intent_id))
BEGIN SELECT RAISE(ABORT,'immutable PostgreSQL claim'); END;
CREATE TRIGGER postgresql_observation_no_update BEFORE UPDATE ON postgresql_read_observations BEGIN SELECT RAISE(ABORT,'immutable PostgreSQL observation'); END;
CREATE TRIGGER postgresql_observation_no_delete BEFORE DELETE ON postgresql_read_observations BEGIN SELECT RAISE(ABORT,'immutable PostgreSQL observation'); END;
CREATE TRIGGER postgresql_observation_no_replace BEFORE INSERT ON postgresql_read_observations
WHEN EXISTS(SELECT 1 FROM postgresql_read_observations WHERE tenant_id=NEW.tenant_id AND request_id=NEW.request_id)
BEGIN SELECT RAISE(ABORT,'immutable PostgreSQL observation'); END;
