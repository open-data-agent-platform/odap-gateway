-- Append acknowledged provider failures without rewriting earlier pending evidence.
CREATE TABLE postgresql_terminal_failures (
  tenant_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  intent_id TEXT NOT NULL,
  statement_digest TEXT NOT NULL,
  sql_state TEXT NOT NULL CHECK(sql_state IN ('57014','42501')),
  recorded_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(tenant_id,request_id),
  FOREIGN KEY(tenant_id,request_id) REFERENCES postgresql_read_claims(tenant_id,request_id),
  FOREIGN KEY(tenant_id,intent_id) REFERENCES postgresql_read_claims(tenant_id,intent_id)
) WITHOUT ROWID;
CREATE TRIGGER postgresql_terminal_guard BEFORE INSERT ON postgresql_terminal_failures BEGIN
  SELECT RAISE(ABORT,'PostgreSQL terminal binding unavailable') WHERE NOT EXISTS(
    SELECT 1 FROM postgresql_read_claims c WHERE c.tenant_id=NEW.tenant_id AND c.request_id=NEW.request_id
      AND c.intent_id=NEW.intent_id AND c.statement_digest=NEW.statement_digest);
  SELECT RAISE(ABORT,'Conflicting PostgreSQL outcome') WHERE EXISTS(
    SELECT 1 FROM postgresql_read_observations o WHERE o.tenant_id=NEW.tenant_id AND o.request_id=NEW.request_id AND o.outcome='succeeded');
END;
CREATE TRIGGER postgresql_terminal_receipt AFTER INSERT ON postgresql_terminal_failures BEGIN
  INSERT INTO evidence_receipts(tenant_id,id,release_id,contract_id,payload,created_by)
  SELECT q.tenant_id,'pg-failed-'||NEW.intent_id,q.release_id,a.contract_id,json_object(
    'schemaVersion','0.1','id','pg-failed-'||NEW.intent_id,'tenantId',q.tenant_id,'intentId',NEW.intent_id,
    'contractId',a.contract_id,'semanticReleaseId',q.release_id,'outcome','failed',
    'reason',CASE NEW.sql_state WHEN '57014' THEN 'postgresql_query_canceled_acknowledged' ELSE 'postgresql_permission_denied_acknowledged' END,
    'recordedAt',NEW.recorded_at),c.claimed_by
  FROM postgresql_read_requests q JOIN postgresql_read_approvals a ON a.tenant_id=q.tenant_id AND a.request_id=q.id
  JOIN postgresql_read_claims c ON c.tenant_id=q.tenant_id AND c.request_id=q.id
  WHERE q.tenant_id=NEW.tenant_id AND q.id=NEW.request_id AND c.intent_id=NEW.intent_id;
  SELECT CASE WHEN changes()<>1 THEN RAISE(ABORT,'PostgreSQL terminal receipt unavailable') END;
END;
CREATE TRIGGER postgresql_observation_terminal_guard BEFORE INSERT ON postgresql_read_observations
WHEN EXISTS(SELECT 1 FROM postgresql_terminal_failures t WHERE t.tenant_id=NEW.tenant_id AND t.request_id=NEW.request_id)
BEGIN SELECT RAISE(ABORT,'PostgreSQL outcome already terminal'); END;
CREATE TRIGGER postgresql_terminal_no_update BEFORE UPDATE ON postgresql_terminal_failures
BEGIN SELECT RAISE(ABORT,'immutable PostgreSQL terminal outcome'); END;
CREATE TRIGGER postgresql_terminal_no_delete BEFORE DELETE ON postgresql_terminal_failures
BEGIN SELECT RAISE(ABORT,'immutable PostgreSQL terminal outcome'); END;
CREATE TRIGGER postgresql_terminal_no_replace BEFORE INSERT ON postgresql_terminal_failures
WHEN EXISTS(SELECT 1 FROM postgresql_terminal_failures WHERE tenant_id=NEW.tenant_id AND request_id=NEW.request_id)
BEGIN SELECT RAISE(ABORT,'immutable PostgreSQL terminal outcome'); END;
