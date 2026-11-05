"""One SQLite connection per call to exercise recovery across fresh processes."""
import json
import hashlib
import sqlite3
import sys
from pathlib import Path

path, mode = sys.argv[1:3]
db = sqlite3.connect(path, timeout=15)
db.row_factory = sqlite3.Row
db.execute("PRAGMA foreign_keys=ON")
migrations = Path(__file__).resolve().parents[2] / "db/migrations"
if mode == "apply-scan-limits":
    db.executescript((migrations / "0007_bigquery_scan_limits.sql").read_text(encoding="utf-8"))
    result = None
elif mode in ("setup", "setup-v6"):
    for migration in sorted(migrations.glob("*.sql")):
        if mode == "setup-v6" and int(migration.name.split("_", 1)[0]) > 6:
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
    if mode in ("run-after-expiry", "run-after-price-expiry"):
        clock = sqlite3.connect(":memory:")
        future = "2100-01-01" if mode == "run-after-expiry" else "2090-01-01"
        db.create_function("julianday", 1, lambda v: clock.execute("SELECT julianday(?)",
                           (future if v == "now" else v,)).fetchone()[0])
    sql, params = json.loads(sys.argv[3])
    cursor = db.execute(sql, params)
    if mode == "first":
        row = cursor.fetchone()
        result = dict(row) if row is not None else None
    else:
        result = {"success": True, "meta": {"changes": cursor.rowcount}}
db.commit()
db.close()
print(json.dumps(result))
