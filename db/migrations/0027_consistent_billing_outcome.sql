-- Prevent a direct bill insert from settling a contradictory restored history.
-- No historical observation, receipt or ledger entry is rewritten.
CREATE TRIGGER billing_requires_consistent_terminal_outcome
BEFORE INSERT ON bigquery_billing_evidence
WHEN (SELECT COUNT(DISTINCT outcome) FROM bigquery_terminal_observations
      WHERE tenant_id=NEW.tenant_id AND intent_id=NEW.intent_id) > 1
BEGIN
  SELECT RAISE(ABORT, 'conflicting terminal outcomes');
END;
