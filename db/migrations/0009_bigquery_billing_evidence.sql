-- No backfill: historical settlements are not proof of an identified bill.
CREATE TABLE bigquery_billing_evidence (
  tenant_id TEXT NOT NULL, intent_id TEXT NOT NULL, receipt_id TEXT NOT NULL,
  evidence_ref TEXT NOT NULL CHECK(length(trim(evidence_ref)) BETWEEN 1 AND 128),
  actual_micro_usd INTEGER NOT NULL CHECK(typeof(actual_micro_usd)='integer'
    AND actual_micro_usd BETWEEN 0 AND 9007199254740991),
  actor TEXT NOT NULL, recorded_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(tenant_id,intent_id), UNIQUE(tenant_id,evidence_ref),
  FOREIGN KEY(tenant_id,intent_id) REFERENCES dispatch_claims(tenant_id,intent_id),
  FOREIGN KEY(tenant_id,receipt_id) REFERENCES evidence_receipts(tenant_id,id)
) WITHOUT ROWID;

CREATE TRIGGER bigquery_bill_guard BEFORE INSERT ON bigquery_billing_evidence BEGIN
  SELECT RAISE(ABORT,'billing evidence denied') WHERE NOT EXISTS (
    SELECT 1 FROM bigquery_job_bindings b
    JOIN bigquery_terminal_observations o ON o.tenant_id=b.tenant_id AND o.intent_id=b.intent_id
    JOIN control_memberships m ON m.tenant_id=b.tenant_id
    WHERE b.tenant_id=NEW.tenant_id AND b.intent_id=NEW.intent_id
      AND NEW.receipt_id='final_'||b.job_id AND m.principal_id=NEW.actor AND m.role='owner' AND m.active=1);
  SELECT RAISE(ABORT,'billing evidence conflict') WHERE
    EXISTS(SELECT 1 FROM bigquery_billing_evidence WHERE tenant_id=NEW.tenant_id
      AND (intent_id=NEW.intent_id OR evidence_ref=NEW.evidence_ref))
    OR EXISTS(SELECT 1 FROM cost_settlements WHERE tenant_id=NEW.tenant_id AND intent_id=NEW.intent_id)
    OR EXISTS(SELECT 1 FROM evidence_receipts WHERE tenant_id=NEW.tenant_id AND id=NEW.receipt_id);
END;
CREATE TRIGGER bigquery_bill_no_update BEFORE UPDATE ON bigquery_billing_evidence
BEGIN SELECT RAISE(ABORT,'immutable billing evidence'); END;
CREATE TRIGGER bigquery_bill_no_delete BEFORE DELETE ON bigquery_billing_evidence
BEGIN SELECT RAISE(ABORT,'immutable billing evidence'); END;

-- Claimed, bounded jobs cannot use the generic settlement writer without a bill.
CREATE TRIGGER bounded_job_settlement_guard BEFORE INSERT ON cost_settlements
WHEN EXISTS(SELECT 1 FROM dispatch_claims WHERE tenant_id=NEW.tenant_id
  AND intent_id=NEW.intent_id AND maximum_bytes_billed IS NOT NULL)
AND NOT EXISTS(SELECT 1 FROM bigquery_billing_evidence WHERE tenant_id=NEW.tenant_id
  AND intent_id=NEW.intent_id AND receipt_id=NEW.receipt_id AND actual_micro_usd=NEW.actual_units AND actor=NEW.actor)
BEGIN SELECT RAISE(ABORT,'bound job billing evidence required'); END;
CREATE TRIGGER settlement_no_replace BEFORE INSERT ON cost_settlements
WHEN EXISTS(SELECT 1 FROM cost_settlements WHERE tenant_id=NEW.tenant_id
  AND (intent_id=NEW.intent_id OR receipt_id=NEW.receipt_id))
BEGIN SELECT RAISE(ABORT,'immutable settlement'); END;
CREATE TRIGGER receipt_no_replace BEFORE INSERT ON evidence_receipts
WHEN EXISTS(SELECT 1 FROM evidence_receipts WHERE tenant_id=NEW.tenant_id AND id=NEW.id)
BEGIN SELECT RAISE(ABORT,'immutable receipt'); END;
CREATE TRIGGER bigquery_final_receipt_guard BEFORE INSERT ON evidence_receipts
WHEN NEW.id GLOB 'final_odap_*' AND NOT EXISTS (
  SELECT 1 FROM bigquery_billing_evidence WHERE tenant_id=NEW.tenant_id
    AND intent_id=json_extract(NEW.payload,'$.intentId') AND receipt_id=NEW.id AND actor=NEW.created_by)
BEGIN SELECT RAISE(ABORT,'bound job billing evidence required'); END;

-- Trigger writes and the existing budget trigger share the outer statement:
-- either all evidence and ledger effects commit, or none do.
CREATE TRIGGER bigquery_bill_apply AFTER INSERT ON bigquery_billing_evidence BEGIN
  INSERT INTO evidence_receipts(tenant_id,id,release_id,contract_id,payload,created_by)
    SELECT b.tenant_id,NEW.receipt_id,p.release_id,p.contract_id,
      json_object('contractId',p.contract_id,'id',NEW.receipt_id,'intentId',b.intent_id,
        'outcome',o.outcome,'reason','BigQuery terminal observation and final job charge',
        'recordedAt',NEW.recorded_at,'schemaVersion','0.1','semanticReleaseId',p.release_id,
        'tenantId',b.tenant_id),NEW.actor
    FROM bigquery_job_bindings b JOIN evidence_receipts p ON p.tenant_id=b.tenant_id AND p.id=b.receipt_id
    JOIN bigquery_terminal_observations o ON o.tenant_id=b.tenant_id AND o.intent_id=b.intent_id
    WHERE b.tenant_id=NEW.tenant_id AND b.intent_id=NEW.intent_id ORDER BY o.has_bytes DESC LIMIT 1;
  SELECT RAISE(ABORT,'final receipt required') WHERE changes()<>1;
  INSERT INTO cost_settlements(tenant_id,intent_id,receipt_id,actual_units,actor)
    VALUES(NEW.tenant_id,NEW.intent_id,NEW.receipt_id,NEW.actual_micro_usd,NEW.actor);
  SELECT RAISE(ABORT,'final settlement required') WHERE changes()<>1;
END;
