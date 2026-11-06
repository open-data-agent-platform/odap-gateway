-- Protect the shared control-object audit log without rewriting old events.
CREATE TRIGGER control_event_no_update BEFORE UPDATE ON control_object_events
BEGIN SELECT RAISE(ABORT,'immutable control event'); END;
CREATE TRIGGER control_event_no_delete BEFORE DELETE ON control_object_events
BEGIN SELECT RAISE(ABORT,'immutable control event'); END;

-- REPLACE can silently delete the old row when recursive triggers are off.
-- Check occupied positive keys before conflict handling; validate the final
-- generated sequence AFTER INSERT so a legacy negative key cannot block appends.
CREATE TRIGGER control_event_no_replace BEFORE INSERT ON control_object_events
WHEN NEW.sequence>0 AND EXISTS (SELECT 1 FROM control_object_events WHERE sequence=NEW.sequence)
BEGIN SELECT RAISE(ABORT,'immutable control event'); END;

CREATE TRIGGER control_event_append_guard AFTER INSERT ON control_object_events BEGIN
  SELECT RAISE(ABORT,'invalid control event sequence') WHERE NEW.sequence<=0
    OR EXISTS (SELECT 1 FROM control_object_events WHERE sequence>NEW.sequence);
  SELECT RAISE(ABORT,'duplicate receipt event') WHERE NEW.object_kind='receipt' AND EXISTS (
    SELECT 1 FROM control_object_events e WHERE e.tenant_id=NEW.tenant_id AND e.object_kind='receipt'
      AND e.object_id=NEW.object_id AND e.sequence<>NEW.sequence);
  -- receipt_created and the parent insert use the same database statement clock.
  SELECT RAISE(ABORT,'unmatched receipt event') WHERE NEW.object_kind='receipt' AND (
    NEW.recorded_at IS NOT strftime('%Y-%m-%dT%H:%M:%fZ','now') OR NOT EXISTS (
      SELECT 1 FROM evidence_receipts r WHERE r.tenant_id=NEW.tenant_id AND r.id=NEW.object_id
        AND r.created_by=NEW.actor AND r.created_at=NEW.recorded_at));
END;
