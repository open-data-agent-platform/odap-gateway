"""Real SQLite concurrency and transaction rollback tests for admission."""
import json
import sqlite3
import tempfile
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor

root = Path(__file__).parents[1]
with tempfile.TemporaryDirectory() as folder:
    path = str(Path(folder) / "admission.db")
    db = sqlite3.connect(path)
    db.execute("PRAGMA foreign_keys=ON")
    for migration in sorted((root / "db/migrations").glob("*.sql")):
        db.executescript(migration.read_text())
    db.execute("INSERT INTO control_tenants VALUES ('t','Tenant')")
    db.execute("INSERT INTO control_memberships VALUES ('t','u','reader',1)")
    db.execute("INSERT INTO semantic_releases(tenant_id,id,payload,created_by) VALUES ('t','r',?,'owner')",
               (json.dumps({"id": "r", "tenantId": "t"}),))
    db.execute("INSERT INTO control_budgets(tenant_id,id,limit_units) VALUES ('t','b',100)")
    for index in range(8):
        name = str(index)
        payload = {"id": name, "tenantId": "t", "semanticReleaseId": "r", "state": "authorized",
                   "principalId": "u", "actionDigest": "q", "reservationId": name,
                   "expiresAt": "2099-01-01T00:00:00.000Z"}
        db.execute("INSERT INTO approval_contracts(tenant_id,id,release_id,payload,created_by) VALUES ('t',?,'r',?,'owner')", (name, json.dumps(payload)))
    db.commit()
    sql = "INSERT INTO execution_intents(tenant_id,id,contract_id,budget_id,reservation_id,principal_id,action_digest,reserved_units) VALUES ('t',?,?,'b',?,'u','q',30)"

    def attempt(index):
        connection = sqlite3.connect(path, timeout=10)
        connection.execute("PRAGMA foreign_keys=ON")
        name = str(index)
        try:
            connection.execute(sql, (name, name, name))
            connection.commit()
            return True
        except sqlite3.IntegrityError:
            connection.rollback()
            return False
        finally:
            connection.close()

    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(attempt, range(8)))
    assert sum(results) == 3
    assert db.execute("SELECT reserved_units FROM control_budgets").fetchone()[0] == 90
    assert db.execute("SELECT count(*) FROM contract_lifecycle WHERE state='consumed'").fetchone()[0] == 3
    assert db.execute("SELECT count(*) FROM execution_intents").fetchone()[0] == 3
    winner = results.index(True)
    assert attempt(winner) is False
    assert db.execute("SELECT reserved_units FROM control_budgets").fetchone()[0] == 90
    # Force a unique-ID failure after trigger work; reservation and consumption roll back.
    loser = str(results.index(False))
    db.execute("UPDATE control_budgets SET limit_units=200")
    db.commit()
    try:
        db.execute(sql, (str(winner), loser, loser))
    except sqlite3.IntegrityError:
        db.rollback()
    else:
        raise AssertionError("Duplicate intent accepted")
    assert db.execute("SELECT reserved_units FROM control_budgets").fetchone()[0] == 90
    assert db.execute("SELECT state FROM contract_lifecycle WHERE contract_id=?", (loser,)).fetchone()[0] == "authorized"
    db.execute("UPDATE control_memberships SET active=0")
    db.commit()
    assert attempt(int(loser)) is False
    db.close()
print("Budget concurrency, duplicate and rollback tests passed")
