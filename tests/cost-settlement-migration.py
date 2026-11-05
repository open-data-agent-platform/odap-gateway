"""Settlement atomicity, evidence binding and overrun accounting."""
import json
import sqlite3
from pathlib import Path

db = sqlite3.connect(":memory:")
db.execute("PRAGMA foreign_keys=ON")
for migration in sorted((Path(__file__).parents[1] / "db/migrations").glob("*.sql")):
    db.executescript(migration.read_text())
db.execute("INSERT INTO control_tenants VALUES ('t','Tenant')")
db.execute("INSERT INTO control_memberships VALUES ('t','u','owner',1)")
db.execute("INSERT INTO semantic_releases(tenant_id,id,payload,created_by) VALUES('t','r',?,'u')", (json.dumps({"id": "r", "tenantId": "t"}),))
db.execute("INSERT INTO control_budgets(tenant_id,id,limit_units) VALUES('t','b',100)")
for name in ["one", "two"]:
    contract = {"id": name, "tenantId": "t", "semanticReleaseId": "r", "principalId": "u", "state": "authorized",
                "actionDigest": "q", "reservationId": name, "expiresAt": "2099-01-01T00:00:00.000Z"}
    db.execute("INSERT INTO approval_contracts(tenant_id,id,release_id,payload,created_by) VALUES('t',?,'r',?,'u')", (name, json.dumps(contract)))
db.execute("INSERT INTO execution_intents VALUES('t','one','one','b','one','u','q',60,'now')")
receipt = {"id": "receipt", "tenantId": "t", "intentId": "one", "contractId": "one", "semanticReleaseId": "r", "outcome": "succeeded"}
db.execute("INSERT INTO evidence_receipts(tenant_id,id,release_id,contract_id,payload,created_by) VALUES('t','receipt','r','one',?,'u')", (json.dumps(receipt),))
db.execute("INSERT INTO cost_settlements(tenant_id,intent_id,receipt_id,actual_units,actor) VALUES('t','one','receipt',150,'u')")
assert db.execute("SELECT reserved_units,spent_units,overrun_units FROM control_budgets").fetchone() == (0, 100, 50)
for sql in [
    "INSERT INTO cost_settlements(tenant_id,intent_id,receipt_id,actual_units,actor) VALUES('t','one','receipt',150,'u')",
    "INSERT INTO execution_intents VALUES('t','two','two','b','two','u','q',0,'now')",
    "UPDATE cost_settlements SET actual_units=0",
]:
    try:
        db.execute(sql)
    except sqlite3.IntegrityError:
        pass
    else:
        raise AssertionError("Invalid settlement/admission accepted")
assert db.execute("SELECT actual_units FROM cost_settlements").fetchone()[0] == 150
assert db.execute("SELECT spent_units,overrun_units FROM control_budgets").fetchone() == (100, 50)
db.execute("INSERT INTO control_budgets(tenant_id,id,limit_units) VALUES('t','b2',100)")
db.execute("INSERT INTO execution_intents VALUES('t','two','two','b2','two','u','q',50,'now')")
db.commit()
try:
    with db:
        bad = {"id": "bad", "tenantId": "t", "intentId": "wrong", "contractId": "two", "semanticReleaseId": "r", "outcome": "succeeded"}
        db.execute("INSERT INTO evidence_receipts(tenant_id,id,release_id,contract_id,payload,created_by) VALUES('t','bad','r','two',?,'u')", (json.dumps(bad),))
        db.execute("INSERT INTO cost_settlements(tenant_id,intent_id,receipt_id,actual_units,actor) VALUES('t','two','bad',20,'u')")
except sqlite3.IntegrityError:
    pass
else:
    raise AssertionError("Mismatched evidence accepted")
assert db.execute("SELECT count(*) FROM evidence_receipts WHERE id='bad'").fetchone()[0] == 0
assert db.execute("SELECT reserved_units FROM control_budgets WHERE id='b2'").fetchone()[0] == 50
good = {"id": "good", "tenantId": "t", "intentId": "two", "contractId": "two", "semanticReleaseId": "r", "outcome": "failed"}
with db:
    db.execute("INSERT INTO evidence_receipts(tenant_id,id,release_id,contract_id,payload,created_by) VALUES('t','good','r','two',?,'u')", (json.dumps(good),))
    db.execute("INSERT INTO cost_settlements(tenant_id,intent_id,receipt_id,actual_units,actor) VALUES('t','two','good',20,'u')")
assert db.execute("SELECT reserved_units,spent_units,overrun_units FROM control_budgets WHERE id='b2'").fetchone() == (0, 20, 0)
print("Settlement normal/overrun, atomic evidence, duplicate and rollback constraints passed")
