"""Verify lifecycle transitions and a concurrent single-use state claim."""
import json
import sqlite3
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

root = Path(__file__).parents[1]
with tempfile.TemporaryDirectory() as folder:
    path = str(Path(folder) / "test.db")
    db = sqlite3.connect(path)
    db.execute("PRAGMA foreign_keys=ON")
    for name in ["0001_control_objects.sql", "0002_contract_lifecycle.sql"]:
        db.executescript((root / "db/migrations" / name).read_text())
    db.execute("INSERT INTO control_tenants VALUES ('t','Tenant')")
    db.execute("INSERT INTO semantic_releases(tenant_id,id,payload,created_by) VALUES ('t','r',?,'owner')",
               (json.dumps({"id": "r", "tenantId": "t"}),))
    for name in ["consume", "revoke"]:
        payload = json.dumps({"id": name, "tenantId": "t", "semanticReleaseId": "r", "state": "authorized"})
        db.execute("INSERT INTO approval_contracts(tenant_id,id,release_id,payload,created_by) VALUES ('t',?,'r',?,'owner')", (name, payload))
    db.commit()

    def claim(_):
        connection = sqlite3.connect(path, timeout=10)
        try:
            cursor = connection.execute("UPDATE contract_lifecycle SET state='consumed',changed_by='test',reason='claim' WHERE tenant_id='t' AND contract_id='consume' AND state='authorized'")
            connection.commit()
            return cursor.rowcount
        finally:
            connection.close()

    with ThreadPoolExecutor(max_workers=8) as pool:
        assert sum(pool.map(claim, range(8))) == 1
    db.execute("UPDATE contract_lifecycle SET state='revoked',changed_by='owner',reason='withdrawn' WHERE contract_id='revoke'")
    try:
        db.execute("UPDATE contract_lifecycle SET state='authorized' WHERE contract_id='revoke'")
    except sqlite3.IntegrityError:
        pass
    else:
        raise AssertionError("Revoked contract reactivated")
    assert db.execute("SELECT count(*) FROM contract_lifecycle_events WHERE state='consumed'").fetchone()[0] == 1
    assert json.loads(db.execute("SELECT payload FROM approval_contracts WHERE id='revoke'").fetchone()[0])["state"] == "authorized"
    db.close()
print("Lifecycle constraints and concurrent claim passed")
