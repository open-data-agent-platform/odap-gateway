-- A claim reserves capacity until durable provider evidence establishes a terminal outcome.
CREATE TABLE postgresql_concurrency_limits (
  tenant_id TEXT NOT NULL,
  budget_id TEXT NOT NULL,
  limit_in_flight INTEGER NOT NULL CHECK(typeof(limit_in_flight)='integer' AND limit_in_flight BETWEEN 1 AND 1000),
  PRIMARY KEY(tenant_id,budget_id),
  FOREIGN KEY(tenant_id,budget_id) REFERENCES postgresql_read_budgets(tenant_id,id)
) WITHOUT ROWID;
CREATE VIEW postgresql_resource_usage AS
SELECT b.tenant_id,b.id AS budget_id,l.limit_in_flight,
  (SELECT count(*) FROM postgresql_read_claims c
   WHERE c.tenant_id=b.tenant_id AND c.budget_id=b.id
     AND NOT EXISTS(SELECT 1 FROM postgresql_read_observations o
       WHERE o.tenant_id=c.tenant_id AND o.request_id=c.request_id AND o.intent_id=c.intent_id AND o.outcome='succeeded')
     AND NOT EXISTS(SELECT 1 FROM postgresql_terminal_failures t
       WHERE t.tenant_id=c.tenant_id AND t.request_id=c.request_id AND t.intent_id=c.intent_id)) AS unresolved_claims
FROM postgresql_read_budgets b LEFT JOIN postgresql_concurrency_limits l
  ON l.tenant_id=b.tenant_id AND l.budget_id=b.id;
CREATE TRIGGER postgresql_claim_capacity BEFORE INSERT ON postgresql_read_claims BEGIN
  SELECT RAISE(ABORT,'PostgreSQL concurrent capacity unavailable') WHERE NOT EXISTS(
    SELECT 1 FROM postgresql_resource_usage u WHERE u.tenant_id=NEW.tenant_id AND u.budget_id=NEW.budget_id
      AND u.unresolved_claims<u.limit_in_flight);
END;
CREATE TRIGGER postgresql_concurrency_no_update BEFORE UPDATE ON postgresql_concurrency_limits
BEGIN SELECT RAISE(ABORT,'immutable PostgreSQL concurrency limit'); END;
CREATE TRIGGER postgresql_concurrency_no_delete BEFORE DELETE ON postgresql_concurrency_limits
BEGIN SELECT RAISE(ABORT,'immutable PostgreSQL concurrency limit'); END;
CREATE TRIGGER postgresql_concurrency_no_replace BEFORE INSERT ON postgresql_concurrency_limits
WHEN EXISTS(SELECT 1 FROM postgresql_concurrency_limits WHERE tenant_id=NEW.tenant_id AND budget_id=NEW.budget_id)
BEGIN SELECT RAISE(ABORT,'immutable PostgreSQL concurrency limit'); END;
