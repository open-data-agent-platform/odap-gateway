-- Cancellation intent is pending evidence, not a provider terminal acknowledgement.
CREATE TABLE postgresql_cancellation_requests (
  tenant_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  intent_id TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  requested_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(tenant_id,request_id),
  FOREIGN KEY(tenant_id,request_id) REFERENCES postgresql_read_claims(tenant_id,request_id),
  FOREIGN KEY(tenant_id,intent_id) REFERENCES postgresql_read_claims(tenant_id,intent_id)
) WITHOUT ROWID;
CREATE VIEW postgresql_cancellable_reads AS
SELECT c.tenant_id,c.request_id,c.intent_id,q.requester_id,v.owner_id
FROM postgresql_read_claims c
JOIN postgresql_read_requests q ON q.tenant_id=c.tenant_id AND q.id=c.request_id
JOIN postgresql_source_versions v ON v.tenant_id=q.tenant_id AND v.id=q.source_id
WHERE NOT EXISTS(SELECT 1 FROM postgresql_terminal_failures t WHERE t.tenant_id=c.tenant_id AND t.request_id=c.request_id)
  AND NOT EXISTS(SELECT 1 FROM postgresql_read_observations o WHERE o.tenant_id=c.tenant_id AND o.request_id=c.request_id AND o.outcome='succeeded');
CREATE TRIGGER postgresql_cancel_guard BEFORE INSERT ON postgresql_cancellation_requests BEGIN
  SELECT RAISE(ABORT,'PostgreSQL cancellation unavailable') WHERE NOT EXISTS(
    SELECT 1 FROM postgresql_cancellable_reads c
    JOIN control_memberships m ON m.tenant_id=c.tenant_id AND m.principal_id=NEW.requested_by AND m.active=1
      AND (m.principal_id=c.requester_id OR (m.principal_id=c.owner_id AND m.role='owner'))
    WHERE c.tenant_id=NEW.tenant_id AND c.request_id=NEW.request_id AND c.intent_id=NEW.intent_id);
END;
CREATE TRIGGER postgresql_cancel_receipt AFTER INSERT ON postgresql_cancellation_requests BEGIN
  INSERT INTO evidence_receipts(tenant_id,id,release_id,contract_id,payload,created_by)
  SELECT q.tenant_id,'pg-cancel-'||NEW.intent_id,q.release_id,a.contract_id,json_object(
    'schemaVersion','0.1','id','pg-cancel-'||NEW.intent_id,'tenantId',q.tenant_id,'intentId',NEW.intent_id,
    'contractId',a.contract_id,'semanticReleaseId',q.release_id,'outcome','pending',
    'reason','postgresql_cancellation_requested','recordedAt',NEW.requested_at),NEW.requested_by
  FROM postgresql_read_requests q JOIN postgresql_read_approvals a ON a.tenant_id=q.tenant_id AND a.request_id=q.id
  WHERE q.tenant_id=NEW.tenant_id AND q.id=NEW.request_id;
  SELECT CASE WHEN changes()<>1 THEN RAISE(ABORT,'PostgreSQL cancellation receipt unavailable') END;
END;
CREATE TRIGGER postgresql_cancel_no_update BEFORE UPDATE ON postgresql_cancellation_requests
BEGIN SELECT RAISE(ABORT,'immutable PostgreSQL cancellation'); END;
CREATE TRIGGER postgresql_cancel_no_delete BEFORE DELETE ON postgresql_cancellation_requests
BEGIN SELECT RAISE(ABORT,'immutable PostgreSQL cancellation'); END;
CREATE TRIGGER postgresql_cancel_no_replace BEFORE INSERT ON postgresql_cancellation_requests
WHEN EXISTS(SELECT 1 FROM postgresql_cancellation_requests WHERE tenant_id=NEW.tenant_id AND request_id=NEW.request_id)
BEGIN SELECT RAISE(ABORT,'immutable PostgreSQL cancellation'); END;
