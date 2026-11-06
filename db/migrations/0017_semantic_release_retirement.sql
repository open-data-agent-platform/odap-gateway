-- Existing markers continue to deny dispatch. Their actor and time are unknown.
ALTER TABLE dispatch_retired_releases ADD COLUMN retired_by TEXT;
ALTER TABLE dispatch_retired_releases ADD COLUMN retired_at TEXT;

CREATE TRIGGER guard_semantic_retirement BEFORE INSERT ON dispatch_retired_releases BEGIN
  SELECT RAISE(ABORT,'semantic retirement unavailable') WHERE NOT EXISTS (
    SELECT 1 FROM semantic_releases r JOIN control_memberships m
      ON m.tenant_id=r.tenant_id AND m.principal_id=json_extract(r.payload,'$.owner')
    WHERE r.tenant_id=NEW.tenant_id AND r.id=NEW.release_id AND json_extract(r.payload,'$.state')='released'
      AND m.principal_id=NEW.retired_by AND m.role='owner' AND m.active=1);
  SELECT RAISE(ABORT,'invalid semantic retirement') WHERE
    NEW.retired_at IS NOT strftime('%Y-%m-%dT%H:%M:%fZ','now')
    OR length(trim(NEW.reason)) NOT BETWEEN 1 AND 1024;
  SELECT RAISE(IGNORE) WHERE EXISTS (SELECT 1 FROM dispatch_retired_releases
    WHERE tenant_id=NEW.tenant_id AND release_id=NEW.release_id);
  SELECT RAISE(ABORT,'immutable semantic retirement') WHERE EXISTS (
    SELECT 1 FROM dispatch_retired_releases WHERE rowid=NEW.rowid);
END;
CREATE TRIGGER retirement_no_update BEFORE UPDATE ON dispatch_retired_releases
BEGIN SELECT RAISE(ABORT,'immutable semantic retirement'); END;
CREATE TRIGGER retirement_no_delete BEFORE DELETE ON dispatch_retired_releases
BEGIN SELECT RAISE(ABORT,'immutable semantic retirement'); END;
CREATE TRIGGER audit_semantic_retirement AFTER INSERT ON dispatch_retired_releases BEGIN
  INSERT INTO control_object_events(tenant_id,object_kind,object_id,actor)
    VALUES(NEW.tenant_id,'semantic_release_retirement',NEW.release_id,NEW.retired_by);
END;

-- Protect the durable claim itself, including writers outside the eligibility view.
CREATE TRIGGER retired_release_no_claim BEFORE INSERT ON dispatch_claims
WHEN EXISTS (
  SELECT 1 FROM execution_intents i JOIN approval_contracts c ON c.tenant_id=i.tenant_id AND c.id=i.contract_id
  JOIN dispatch_retired_releases r ON r.tenant_id=c.tenant_id AND r.release_id=c.release_id
  WHERE i.tenant_id=NEW.tenant_id AND i.id=NEW.intent_id)
BEGIN SELECT RAISE(ABORT,'semantic release retired'); END;
