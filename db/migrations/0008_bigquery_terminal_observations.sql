-- A terminal job is not an invoice. No settlement, receipt or budget writes.
CREATE TABLE bigquery_terminal_observations (
  tenant_id TEXT NOT NULL, intent_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('succeeded','failed','cancelled')),
  billed_bytes INTEGER CHECK(billed_bytes IS NULL OR
    (typeof(billed_bytes)='integer' AND billed_bytes BETWEEN 0 AND 9007199254740991)),
  has_bytes INTEGER NOT NULL CHECK(has_bytes=(billed_bytes IS NOT NULL)),
  observed_by TEXT NOT NULL,
  observed_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(tenant_id,intent_id,has_bytes),
  FOREIGN KEY(tenant_id,intent_id) REFERENCES dispatch_claims(tenant_id,intent_id)
) WITHOUT ROWID;

CREATE TRIGGER terminal_observation_insert BEFORE INSERT ON bigquery_terminal_observations
BEGIN
  SELECT RAISE(ABORT,'terminal observation denied') WHERE NOT EXISTS (
    SELECT 1 FROM dispatch_claims c
    JOIN control_memberships m ON m.tenant_id=c.tenant_id
    WHERE c.tenant_id=NEW.tenant_id AND c.intent_id=NEW.intent_id
      AND c.maximum_bytes_billed IS NOT NULL
      AND m.principal_id=NEW.observed_by AND m.role='owner' AND m.active=1);
  SELECT RAISE(ABORT,'conflicting terminal observation') WHERE EXISTS (
    SELECT 1 FROM bigquery_terminal_observations
    WHERE tenant_id=NEW.tenant_id AND intent_id=NEW.intent_id
      AND (outcome<>NEW.outcome OR billed_bytes<>NEW.billed_bytes));
  -- Preserve the first witness, even on REPLACE or a stale metadata read.
  SELECT RAISE(IGNORE) WHERE EXISTS (
    SELECT 1 FROM bigquery_terminal_observations
    WHERE tenant_id=NEW.tenant_id AND intent_id=NEW.intent_id
      AND (NEW.billed_bytes IS NULL OR billed_bytes IS NOT NULL));
END;
CREATE TRIGGER terminal_observation_no_update BEFORE UPDATE ON bigquery_terminal_observations
BEGIN SELECT RAISE(ABORT,'immutable terminal observation'); END;
CREATE TRIGGER terminal_observation_no_delete BEFORE DELETE ON bigquery_terminal_observations
BEGIN SELECT RAISE(ABORT,'immutable terminal observation'); END;
