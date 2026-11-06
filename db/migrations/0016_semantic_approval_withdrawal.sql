-- Withdrawal is a terminal fact about an unconsumed approval, not retirement of a release.
CREATE TABLE semantic_approval_withdrawals (
  tenant_id TEXT NOT NULL,
  approval_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  withdrawn_by TEXT NOT NULL,
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1024),
  withdrawn_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(tenant_id,approval_id),
  FOREIGN KEY(tenant_id,approval_id) REFERENCES semantic_candidate_approvals(tenant_id,id)
);

CREATE TRIGGER guard_approval_withdrawal BEFORE INSERT ON semantic_approval_withdrawals
WHEN NOT EXISTS (
  SELECT 1 FROM semantic_candidate_approvals a
  JOIN control_memberships m ON m.tenant_id=a.tenant_id AND m.principal_id=a.approved_by
  WHERE a.tenant_id=NEW.tenant_id AND a.id=NEW.approval_id AND a.revision_id=NEW.revision_id
    AND m.principal_id=NEW.withdrawn_by AND m.role='owner' AND m.active=1)
  OR EXISTS (SELECT 1 FROM semantic_release_promotions WHERE tenant_id=NEW.tenant_id AND approval_id=NEW.approval_id)
  OR EXISTS (SELECT 1 FROM semantic_approval_withdrawals WHERE tenant_id=NEW.tenant_id AND approval_id=NEW.approval_id)
BEGIN SELECT RAISE(IGNORE); END;

CREATE TRIGGER no_promotion_after_withdrawal BEFORE INSERT ON semantic_release_promotions
WHEN EXISTS (SELECT 1 FROM semantic_approval_withdrawals WHERE tenant_id=NEW.tenant_id AND approval_id=NEW.approval_id)
BEGIN SELECT RAISE(ABORT,'semantic promotion unavailable'); END;

CREATE TRIGGER withdrawal_no_update BEFORE UPDATE ON semantic_approval_withdrawals
BEGIN SELECT RAISE(ABORT,'immutable approval withdrawal'); END;
CREATE TRIGGER withdrawal_no_delete BEFORE DELETE ON semantic_approval_withdrawals
BEGIN SELECT RAISE(ABORT,'immutable approval withdrawal'); END;

CREATE TRIGGER audit_approval_withdrawal AFTER INSERT ON semantic_approval_withdrawals BEGIN
  INSERT INTO control_object_events(tenant_id,object_kind,object_id,actor)
    VALUES(NEW.tenant_id,'semantic_approval_withdrawal',NEW.approval_id,NEW.withdrawn_by);
END;
