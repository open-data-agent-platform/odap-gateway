-- A local request names the claimed job; it is neither a send nor an outcome.
CREATE TABLE bigquery_cancellation_requests (
  tenant_id TEXT NOT NULL, intent_id TEXT NOT NULL, job_id TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  requested_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(tenant_id,intent_id),
  FOREIGN KEY(tenant_id,intent_id) REFERENCES dispatch_claims(tenant_id,intent_id)
) WITHOUT ROWID;

CREATE TRIGGER cancellation_request_guard BEFORE INSERT ON bigquery_cancellation_requests BEGIN
  SELECT RAISE(ABORT,'cancellation request unavailable') WHERE NOT EXISTS (
    SELECT 1 FROM dispatch_claims c
    JOIN bigquery_job_bindings b USING(tenant_id,intent_id)
    JOIN control_memberships m ON m.tenant_id=c.tenant_id
    WHERE c.tenant_id=NEW.tenant_id AND c.intent_id=NEW.intent_id AND c.maximum_bytes_billed IS NOT NULL
      AND b.job_id=NEW.job_id AND m.principal_id=NEW.requested_by AND m.role='owner' AND m.active=1);
  SELECT RAISE(ABORT,'invalid cancellation request time')
    WHERE NEW.requested_at IS NOT strftime('%Y-%m-%dT%H:%M:%fZ','now');
  -- Check under the write lock; even INSERT OR REPLACE preserves the first requester.
  SELECT RAISE(IGNORE) WHERE
    EXISTS(SELECT 1 FROM bigquery_terminal_observations WHERE tenant_id=NEW.tenant_id AND intent_id=NEW.intent_id)
    OR EXISTS(SELECT 1 FROM cost_settlements WHERE tenant_id=NEW.tenant_id AND intent_id=NEW.intent_id)
    OR EXISTS(SELECT 1 FROM bigquery_cancellation_requests WHERE tenant_id=NEW.tenant_id AND intent_id=NEW.intent_id);
END;
CREATE TRIGGER cancellation_request_no_update BEFORE UPDATE ON bigquery_cancellation_requests
BEGIN SELECT RAISE(ABORT,'immutable cancellation request'); END;
CREATE TRIGGER cancellation_request_no_delete BEFORE DELETE ON bigquery_cancellation_requests
BEGIN SELECT RAISE(ABORT,'immutable cancellation request'); END;
