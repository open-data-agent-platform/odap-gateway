CREATE TABLE bigquery_job_bindings (
  tenant_id TEXT NOT NULL,
  intent_id TEXT NOT NULL,
  project_id TEXT NOT NULL CHECK(length(trim(project_id)) > 0),
  location TEXT NOT NULL CHECK(length(trim(location)) > 0),
  job_id TEXT NOT NULL CHECK(length(job_id)=69 AND substr(job_id,1,5)='odap_' AND substr(job_id,6) NOT GLOB '*[^0-9a-f]*'),
  action_tag TEXT NOT NULL CHECK(length(action_tag)=48 AND action_tag NOT GLOB '*[^0-9a-f]*'),
  receipt_id TEXT NOT NULL CHECK(receipt_id='pending_' || job_id),
  prepared_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(tenant_id,intent_id),
  UNIQUE(project_id,location,job_id),
  FOREIGN KEY(tenant_id,intent_id) REFERENCES execution_intents(tenant_id,id),
  FOREIGN KEY(tenant_id,receipt_id) REFERENCES evidence_receipts(tenant_id,id)
);

CREATE TRIGGER bigquery_binding_guard BEFORE INSERT ON bigquery_job_bindings BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM execution_intents i
    JOIN control_memberships m ON m.tenant_id=i.tenant_id AND m.principal_id=i.principal_id AND m.active=1
    JOIN control_memberships owner ON owner.tenant_id=i.tenant_id AND owner.principal_id=NEW.prepared_by
    WHERE i.tenant_id=NEW.tenant_id AND i.id=NEW.intent_id AND owner.active=1 AND owner.role='owner'
      AND NOT EXISTS (SELECT 1 FROM cost_settlements WHERE tenant_id=i.tenant_id AND intent_id=i.id)
  ) THEN RAISE(ABORT,'job preparation denied') END;
  -- REPLACE must not silently erase an existing immutable binding or receipt.
  SELECT CASE WHEN EXISTS (SELECT 1 FROM bigquery_job_bindings
    WHERE (tenant_id=NEW.tenant_id AND intent_id=NEW.intent_id)
       OR (project_id=NEW.project_id AND location=NEW.location AND job_id=NEW.job_id))
    OR EXISTS (SELECT 1 FROM evidence_receipts WHERE tenant_id=NEW.tenant_id AND id=NEW.receipt_id)
    THEN RAISE(ABORT,'job binding conflict') END;
END;

CREATE TRIGGER bigquery_pending_receipt AFTER INSERT ON bigquery_job_bindings BEGIN
  INSERT INTO evidence_receipts(tenant_id,id,release_id,contract_id,payload,created_by)
    SELECT i.tenant_id,NEW.receipt_id,c.release_id,c.id,
      json_object('schemaVersion','0.1','id',NEW.receipt_id,'tenantId',i.tenant_id,
        'intentId',i.id,'contractId',c.id,'semanticReleaseId',c.release_id,'outcome','pending',
        'reason','BigQuery job identity prepared; submission not confirmed','recordedAt',NEW.created_at),
      NEW.prepared_by
    FROM execution_intents i JOIN approval_contracts c ON c.tenant_id=i.tenant_id AND c.id=i.contract_id
    WHERE i.tenant_id=NEW.tenant_id AND i.id=NEW.intent_id;
  SELECT CASE WHEN changes()<>1 THEN RAISE(ABORT,'pending receipt required') END;
END;
CREATE TRIGGER bigquery_binding_no_update BEFORE UPDATE ON bigquery_job_bindings
BEGIN SELECT RAISE(ABORT,'immutable job binding'); END;
CREATE TRIGGER bigquery_binding_no_delete BEFORE DELETE ON bigquery_job_bindings
BEGIN SELECT RAISE(ABORT,'immutable job binding'); END;
