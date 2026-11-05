"""One SQLite connection per call to exercise recovery across fresh processes."""
import json
import sqlite3
import sys
from pathlib import Path

path, mode = sys.argv[1:3]
db = sqlite3.connect(path, timeout=15)
db.row_factory = sqlite3.Row
db.execute("PRAGMA foreign_keys=ON")
if mode == "setup":
    for migration in sorted((Path(__file__).resolve().parents[2] / "db/migrations").glob("*.sql")):
        db.executescript(migration.read_text(encoding="utf-8"))
    db.execute("INSERT INTO control_tenants VALUES ('t','Tenant')")
    db.execute("INSERT INTO control_memberships VALUES ('t','owner','owner',1),('t','user','reader',1)")
    db.execute("INSERT INTO semantic_releases(tenant_id,id,payload,created_by) VALUES('t','r',?,'owner')",
               (json.dumps({"id": "r", "tenantId": "t"}),))
    contract = {"id": "c", "tenantId": "t", "semanticReleaseId": "r", "state": "authorized",
                "principalId": "user", "reservationId": "s", "actionDigest": "digest",
                "expiresAt": "2099-01-01T00:00:00.000Z"}
    db.execute("INSERT INTO approval_contracts(tenant_id,id,release_id,payload,created_by) VALUES('t','c','r',?,'owner')",
               (json.dumps(contract),))
    db.execute("INSERT INTO control_budgets(tenant_id,id,limit_units) VALUES('t','b',100)")
    db.execute("INSERT INTO execution_intents VALUES('t','i','c','b','s','user','digest',20,'now')")
    result = None
else:
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
