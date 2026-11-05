-- Keep old markers effective without inventing who stopped them or when.
ALTER TABLE dispatch_stopped_intents ADD COLUMN stopped_by TEXT;
ALTER TABLE dispatch_stopped_intents ADD COLUMN stopped_at TEXT;

CREATE TRIGGER pre_dispatch_stop_guard BEFORE INSERT ON dispatch_stopped_intents BEGIN
  SELECT RAISE(ABORT,'pre-dispatch stop unavailable') WHERE NOT EXISTS (
    SELECT 1 FROM execution_intents i JOIN control_memberships m ON m.tenant_id=i.tenant_id
    WHERE i.tenant_id=NEW.tenant_id AND i.id=NEW.intent_id AND m.principal_id=NEW.stopped_by
      AND m.role='owner' AND m.active=1);
  SELECT RAISE(ABORT,'invalid pre-dispatch stop') WHERE NEW.reason IS NOT 'owner_requested_stop'
    OR NEW.stopped_at IS NOT strftime('%Y-%m-%dT%H:%M:%fZ','now');
  -- Serialize replay, stop and claim at the database, not at preflight.
  SELECT RAISE(IGNORE) WHERE
    EXISTS(SELECT 1 FROM dispatch_claims WHERE tenant_id=NEW.tenant_id AND intent_id=NEW.intent_id)
    OR EXISTS(SELECT 1 FROM cost_settlements WHERE tenant_id=NEW.tenant_id AND intent_id=NEW.intent_id)
    OR EXISTS(SELECT 1 FROM dispatch_stopped_intents WHERE tenant_id=NEW.tenant_id AND intent_id=NEW.intent_id);
  SELECT RAISE(ABORT,'immutable dispatch stop') WHERE EXISTS (
    SELECT 1 FROM dispatch_stopped_intents WHERE rowid=NEW.rowid);
END;
CREATE TRIGGER pre_dispatch_stop_no_update BEFORE UPDATE ON dispatch_stopped_intents
BEGIN SELECT RAISE(ABORT,'immutable dispatch stop'); END;
CREATE TRIGGER pre_dispatch_stop_no_delete BEFORE DELETE ON dispatch_stopped_intents
BEGIN SELECT RAISE(ABORT,'immutable dispatch stop'); END;
CREATE TRIGGER stopped_intent_no_claim BEFORE INSERT ON dispatch_claims
WHEN EXISTS(SELECT 1 FROM dispatch_stopped_intents WHERE tenant_id=NEW.tenant_id AND intent_id=NEW.intent_id)
BEGIN SELECT RAISE(ABORT,'dispatch stopped'); END;
