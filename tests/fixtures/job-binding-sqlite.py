"""One SQLite connection per call to exercise recovery across fresh processes."""
import json
import hashlib
import sqlite3
import sys
from pathlib import Path

path, mode = sys.argv[1:3]
db = (sqlite3.connect(Path(path).resolve().as_uri() + "?mode=ro", uri=True, timeout=15)
      if mode in ("readonly-first", "readonly-first-after-expiry") else sqlite3.connect(path, timeout=15))
db.row_factory = sqlite3.Row
db.execute("PRAGMA foreign_keys=ON")
migrations = Path(__file__).resolve().parents[2] / "db/migrations"
upgrades = {"apply-scan-limits": "0007_bigquery_scan_limits.sql",
            "apply-terminal-observations": "0008_bigquery_terminal_observations.sql",
            "apply-billing-evidence": "0009_bigquery_billing_evidence.sql",
            "apply-preapproval-denials": "0010_missing_release_denials.sql",
            "apply-pre-dispatch-stop": "0011_pre_dispatch_stop.sql",
            "apply-cancellation-requests": "0012_bigquery_cancellation_requests.sql",
            "apply-semantic-revisions": "0013_semantic_revision_validation.sql",
            "apply-semantic-approvals": "0014_semantic_candidate_approvals.sql",
            "apply-semantic-promotion": "0015_semantic_release_promotion.sql",
            "apply-semantic-withdrawal": "0016_semantic_approval_withdrawal.sql",
            "apply-semantic-retirement": "0017_semantic_release_retirement.sql",
            "apply-contract-requests": "0018_contract_requests.sql",
            "apply-human-grants": "0019_contract_human_grants.sql",
            "apply-agent-delegations": "0020_agent_delegations.sql",
            "apply-contract-issuance": "0021_delegated_contract_issuance.sql",
            "apply-delegated-budget": "0022_delegated_budget_admission.sql",
            "apply-delegated-jobs": "0023_delegated_job_preparation.sql",
            "apply-delegated-handoff": "0024_delegated_handoff_claim.sql",
            "apply-delegated-observations": "0025_delegated_observations.sql",
            "apply-delegated-billing": "0026_delegated_billing.sql",
            "apply-consistent-billing-outcome": "0027_consistent_billing_outcome.sql",
            "apply-receipt-corrections": "0030_receipt_reason_corrections.sql",
            "apply-audit-checkpoints": "0031_control_audit_checkpoints.sql",
            "apply-oauth-states": "0032_oauth_login_states.sql",
            "apply-auxiliary-costs": "0033_auxiliary_costs.sql"}
if mode == "migration-statements":
    result = []
    for migration in sorted(migrations.glob("*.sql")):
        statement = ""
        for char in migration.read_text(encoding="utf-8"):
            statement += char
            if char == ";" and sqlite3.complete_statement(statement):
                result.append(statement)
                statement = ""
        if statement.strip():
            raise ValueError("Incomplete migration statement")
elif mode == "batch":
    statements, _ = json.loads(sys.argv[3])
    result = []
    try:
        db.execute("BEGIN IMMEDIATE")
        for sql, params in json.loads(statements):
            cursor = db.execute(sql, params)
            rows = [dict(row) for row in cursor.fetchall()]
            result.append({"success": True, "results": rows,
                           "meta": {"changes": db.execute("SELECT changes()").fetchone()[0]}})
        db.commit()
    except Exception:
        db.rollback()
        raise
elif mode == "apply-legacy-schema":
    db.executescript((migrations.parent / "schema.sql").read_text(encoding="utf-8"))
    result = None
elif mode == "upgrade-v10-snapshot":
    for migration in sorted(migrations.glob("*.sql")):
        if int(migration.name.split("_", 1)[0]) > 10:
            db.executescript(migration.read_text(encoding="utf-8"))
    result = None
elif mode in upgrades:
    db.executescript((migrations / upgrades[mode]).read_text(encoding="utf-8"))
    result = None
elif mode in ("setup", "setup-v6", "setup-v8", "setup-v9", "setup-v10", "setup-v12", "setup-v14", "setup-v16", "setup-v17", "setup-v18", "setup-v19", "setup-v29", "setup-v30", "setup-v32"):
    for migration in sorted(migrations.glob("*.sql")):
        if mode.startswith("setup-v") and int(migration.name.split("_", 1)[0]) > int(mode[len("setup-v"):]):
            continue
        db.executescript(migration.read_text(encoding="utf-8"))
    db.execute("INSERT INTO control_tenants VALUES ('t','Tenant')")
    db.execute("INSERT INTO control_memberships VALUES ('t','owner','owner',1),('t','user','reader',1)")
    metric = json.loads(Path(__file__).with_name("revenue-metric.json").read_text(encoding="utf-8"))
    definition_digest = hashlib.sha256(json.dumps(metric, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    release = {"id": "r", "tenantId": "t", "schemaVersion": "0.1", "state": "released",
               "owner": "owner", "definitionDigest": "sha256:" + definition_digest, "sourceRevision": "s1"}
    db.execute("INSERT INTO semantic_releases(tenant_id,id,payload,created_by) VALUES('t','r',?,'owner')",
               (json.dumps(release),))
    action = {"profile": "odap.metric-read.v1", "target": "orders", "metricId": "revenue", "parameters": {"year": 2026}}
    digest = "sha256:" + hashlib.sha256(json.dumps(action, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    contract = {"id": "c", "tenantId": "t", "semanticReleaseId": "r", "state": "authorized", "schemaVersion": "0.1",
                "agentId": "agent", "target": "orders", "actionType": "data.read", "policyRevision": "p1",
                "sourceRevision": "s1", "authority": {"mode": "human", "reference": "review"},
                "principalId": "user", "reservationId": "s", "actionDigest": digest,
                "expiresAt": "2099-01-01T00:00:00.000Z"}
    db.execute("INSERT INTO approval_contracts(tenant_id,id,release_id,payload,created_by) VALUES('t','c','r',?,'owner')",
               (json.dumps(contract),))
    db.execute("INSERT INTO control_budgets(tenant_id,id,limit_units) VALUES('t','b',100)")
    db.execute("INSERT INTO execution_intents VALUES('t','i','c','b','s','user',?,20,'now')", (digest,))
    result = None
else:
    if mode in ("run-after-expiry", "first-after-expiry", "readonly-first-after-expiry", "run-after-price-expiry", "first-at-scan-expiry"):
        clock = sqlite3.connect(":memory:")
        future = "2090-01-01" if mode == "run-after-price-expiry" else "2100-01-01"
        if mode == "first-at-scan-expiry":
            future = db.execute("SELECT valid_until FROM bigquery_scan_policies").fetchone()[0]
        db.create_function("julianday", 1, lambda v: clock.execute("SELECT julianday(?)",
                           (future if v == "now" else v,)).fetchone()[0])
    sql, params = json.loads(sys.argv[3])
    cursor = db.execute(sql, params)
    if mode in ("first", "readonly-first", "first-after-expiry", "readonly-first-after-expiry", "first-at-scan-expiry"):
        row = cursor.fetchone()
        result = dict(row) if row is not None else None
    else:
        result = {"success": True, "meta": {"changes": cursor.rowcount}}
db.commit()
db.close()
print(json.dumps(result))
