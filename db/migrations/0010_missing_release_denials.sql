-- Record a refusal before an approval or execution intent exists. No backfill.
CREATE TABLE missing_release_denials (
  tenant_id TEXT NOT NULL, attempt_id TEXT NOT NULL CHECK(length(attempt_id) BETWEEN 1 AND 128),
  principal_id TEXT NOT NULL, agent_id TEXT NOT NULL CHECK(length(agent_id) BETWEEN 1 AND 128),
  requested_release TEXT NOT NULL CHECK(length(requested_release) BETWEEN 1 AND 128),
  action_digest TEXT NOT NULL CHECK(length(action_digest)=71 AND substr(action_digest,1,7)='sha256:'
    AND substr(action_digest,8) NOT GLOB '*[^0-9a-f]*'),
  receipt_id TEXT NOT NULL CHECK(receipt_id='denied_preapproval_'||attempt_id),
  recorded_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(tenant_id,attempt_id),
  FOREIGN KEY(tenant_id,receipt_id) REFERENCES evidence_receipts(tenant_id,id)
) WITHOUT ROWID;

CREATE TRIGGER missing_release_denial_guard BEFORE INSERT ON missing_release_denials BEGIN
  SELECT RAISE(ABORT,'pre-approval denial unavailable') WHERE NOT EXISTS (
    SELECT 1 FROM control_memberships WHERE tenant_id=NEW.tenant_id AND principal_id=NEW.principal_id AND active=1);
  -- An exact retry is the original historical decision, even after publication.
  SELECT RAISE(IGNORE) WHERE EXISTS (SELECT 1 FROM missing_release_denials
    WHERE tenant_id=NEW.tenant_id AND attempt_id=NEW.attempt_id AND principal_id=NEW.principal_id
      AND agent_id=NEW.agent_id AND requested_release=NEW.requested_release AND action_digest=NEW.action_digest);
  SELECT RAISE(ABORT,'pre-approval denial unavailable') WHERE
    EXISTS(SELECT 1 FROM missing_release_denials WHERE tenant_id=NEW.tenant_id AND attempt_id=NEW.attempt_id)
    OR EXISTS(SELECT 1 FROM semantic_releases WHERE tenant_id=NEW.tenant_id AND id=NEW.requested_release)
    OR EXISTS(SELECT 1 FROM execution_intents WHERE tenant_id=NEW.tenant_id AND id=NEW.attempt_id)
    OR EXISTS(SELECT 1 FROM evidence_receipts WHERE tenant_id=NEW.tenant_id AND id=NEW.receipt_id);
END;
CREATE TRIGGER missing_release_denial_apply AFTER INSERT ON missing_release_denials BEGIN
  INSERT INTO evidence_receipts(tenant_id,id,contract_id,release_id,payload,created_by)
    VALUES(NEW.tenant_id,NEW.receipt_id,NULL,NULL,
      json_object('schemaVersion','0.1','id',NEW.receipt_id,'tenantId',NEW.tenant_id,
        'intentId',NEW.attempt_id,'contractId',NULL,'semanticReleaseId',NULL,'outcome','denied',
        'reason','Requested semantic release not found in tenant; no approval issued','recordedAt',NEW.recorded_at),
      NEW.principal_id);
  SELECT RAISE(ABORT,'denial receipt required') WHERE changes()<>1;
END;
CREATE TRIGGER missing_release_receipt_guard BEFORE INSERT ON evidence_receipts
WHEN NEW.id GLOB 'denied_preapproval_*' AND NOT EXISTS (SELECT 1 FROM missing_release_denials
  WHERE tenant_id=NEW.tenant_id AND attempt_id=json_extract(NEW.payload,'$.intentId')
    AND receipt_id=NEW.id AND principal_id=NEW.created_by)
BEGIN SELECT RAISE(ABORT,'pre-approval denial required'); END;
CREATE TRIGGER missing_release_denial_no_update BEFORE UPDATE ON missing_release_denials
BEGIN SELECT RAISE(ABORT,'immutable pre-approval denial'); END;
CREATE TRIGGER missing_release_denial_no_delete BEFORE DELETE ON missing_release_denials
BEGIN SELECT RAISE(ABORT,'immutable pre-approval denial'); END;
CREATE TRIGGER denied_attempt_no_admission BEFORE INSERT ON execution_intents
WHEN EXISTS(SELECT 1 FROM missing_release_denials WHERE tenant_id=NEW.tenant_id AND attempt_id=NEW.id)
BEGIN SELECT RAISE(ABORT,'attempt already denied'); END;
