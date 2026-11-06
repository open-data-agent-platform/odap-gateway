-- Side records only: never update the issued receipt or the monetary ledger.
CREATE TABLE receipt_reason_corrections (
  tenant_id TEXT NOT NULL,
  receipt_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),
  corrected_reason TEXT NOT NULL CHECK(typeof(corrected_reason)='text' AND length(corrected_reason) BETWEEN 1 AND 512
    AND length(trim(corrected_reason, ' '||char(9)||char(10)||char(13)))>0 AND instr(corrected_reason,char(0))=0),
  evidence_ref TEXT NOT NULL CHECK(typeof(evidence_ref)='text' AND length(evidence_ref) BETWEEN 1 AND 160
    AND evidence_ref NOT GLOB '*[^a-zA-Z0-9:._-]*' AND instr(evidence_ref,char(0))=0),
  actor TEXT NOT NULL,
  recorded_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(tenant_id,receipt_id,revision),
  FOREIGN KEY(tenant_id,receipt_id) REFERENCES evidence_receipts(tenant_id,id)
) WITHOUT ROWID;

CREATE INDEX receipt_correction_event_lookup ON control_object_events(tenant_id,object_id)
WHERE object_kind='receipt_reason_correction';

CREATE VIEW receipt_correction_targets AS
SELECT p.tenant_id,p.id AS receipt_id,m.principal_id AS owner_id
FROM evidence_receipts p JOIN control_memberships m ON m.tenant_id=p.tenant_id
WHERE m.active=1 AND m.role='owner' AND
  (SELECT COUNT(*)=1 AND MAX(e.actor=p.created_by AND e.recorded_at=p.created_at)
   FROM control_object_events e WHERE e.tenant_id=p.tenant_id AND e.object_kind='receipt' AND e.object_id=p.id)
  AND NOT EXISTS (SELECT 1 FROM receipt_reason_corrections c
    WHERE c.tenant_id=p.tenant_id AND c.receipt_id=p.id AND NOT (
      SELECT COUNT(*)=1 AND MAX(e.actor=c.actor AND e.recorded_at=c.recorded_at)
      FROM control_object_events e WHERE e.tenant_id=c.tenant_id AND e.object_kind='receipt_reason_correction'
        AND e.object_id=json_array(c.receipt_id,c.revision)));

CREATE TRIGGER receipt_correction_guard BEFORE INSERT ON receipt_reason_corrections BEGIN
  SELECT RAISE(ABORT,'receipt correction unavailable') WHERE NOT EXISTS
    (SELECT 1 FROM receipt_correction_targets WHERE tenant_id=NEW.tenant_id AND receipt_id=NEW.receipt_id AND owner_id=NEW.actor);
  SELECT RAISE(ABORT,'invalid correction timestamp') WHERE NEW.recorded_at IS NOT strftime('%Y-%m-%dT%H:%M:%fZ','now');
  -- Exact retries remain readable even after a later revision. Never replace a row.
  SELECT RAISE(IGNORE) WHERE EXISTS (SELECT 1 FROM receipt_reason_corrections
    WHERE tenant_id=NEW.tenant_id AND receipt_id=NEW.receipt_id AND revision=NEW.revision
      AND actor=NEW.actor AND corrected_reason=NEW.corrected_reason AND evidence_ref=NEW.evidence_ref);
  SELECT RAISE(ABORT,'receipt correction revision conflict') WHERE NEW.revision IS NOT
    (SELECT COALESCE(MAX(revision),0)+1 FROM receipt_reason_corrections WHERE tenant_id=NEW.tenant_id AND receipt_id=NEW.receipt_id);
END;
CREATE TRIGGER receipt_correction_no_update BEFORE UPDATE ON receipt_reason_corrections
BEGIN SELECT RAISE(ABORT,'immutable receipt correction'); END;
CREATE TRIGGER receipt_correction_no_delete BEFORE DELETE ON receipt_reason_corrections
BEGIN SELECT RAISE(ABORT,'immutable receipt correction'); END;
CREATE TRIGGER receipt_correction_event_guard BEFORE INSERT ON control_object_events
WHEN NEW.object_kind='receipt_reason_correction' BEGIN
  SELECT RAISE(ABORT,'unmatched correction event') WHERE NOT json_valid(NEW.object_id);
  SELECT RAISE(ABORT,'unmatched correction event') WHERE
    NEW.recorded_at IS NOT strftime('%Y-%m-%dT%H:%M:%fZ','now') OR NOT EXISTS (
      SELECT 1 FROM receipt_reason_corrections c WHERE c.tenant_id=NEW.tenant_id AND c.receipt_id=json_extract(NEW.object_id,'$[0]')
        AND c.revision=json_extract(NEW.object_id,'$[1]') AND NEW.object_id=json_array(c.receipt_id,c.revision)
        AND c.actor=NEW.actor AND c.recorded_at=NEW.recorded_at)
    OR EXISTS (SELECT 1 FROM control_object_events WHERE tenant_id=NEW.tenant_id
      AND object_kind='receipt_reason_correction' AND object_id=NEW.object_id);
END;
CREATE TRIGGER audit_receipt_correction AFTER INSERT ON receipt_reason_corrections BEGIN
  INSERT INTO control_object_events(tenant_id,object_kind,object_id,actor)
  VALUES(NEW.tenant_id,'receipt_reason_correction',json_array(NEW.receipt_id,NEW.revision),NEW.actor);
END;
