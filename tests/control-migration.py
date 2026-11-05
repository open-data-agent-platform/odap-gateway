"""Exercise actual SQLite constraints used by the D1 control migration."""
import json
import sqlite3
from pathlib import Path

db = sqlite3.connect(":memory:")
db.execute("PRAGMA foreign_keys=ON")
db.executescript((Path(__file__).parents[1] / "db/migrations/0001_control_objects.sql").read_text())
db.executemany("INSERT INTO control_tenants VALUES (?,?)", [("a", "A"), ("b", "B")])

def insert_release(tenant):
    db.execute("INSERT INTO semantic_releases(tenant_id,id,payload,created_by) VALUES (?,?,?,?)",
               (tenant, "r", json.dumps({"id": "r", "tenantId": tenant}), "operator"))

def rejected(sql, args=()):
    try:
        db.execute(sql, args)
    except sqlite3.IntegrityError:
        return
    raise AssertionError("Expected database constraint rejection")

insert_release("a")
insert_release("b")
db.execute("INSERT INTO semantic_releases(tenant_id,id,payload,created_by) VALUES (?,?,?,?)",
           ("b", "b-only", json.dumps({"id": "b-only", "tenantId": "b"}), "operator"))
assert db.execute("SELECT count(*) FROM control_object_events").fetchone()[0] == 3
rejected("INSERT INTO approval_contracts(tenant_id,id,release_id,payload,created_by) VALUES (?,?,?,?,?)",
         ("a", "cross-tenant", "b-only", json.dumps({"id": "cross-tenant", "tenantId": "a", "semanticReleaseId": "b-only"}), "operator"))
rejected("UPDATE semantic_releases SET payload='{}' WHERE tenant_id='a'")
rejected("DELETE FROM semantic_releases WHERE tenant_id='a'")
rejected("INSERT INTO approval_contracts(tenant_id,id,release_id,payload,created_by) VALUES (?,?,?,?,?)",
         ("a", "c", "missing", json.dumps({"id": "c", "tenantId": "a", "semanticReleaseId": "missing"}), "operator"))
rejected("INSERT INTO semantic_releases(tenant_id,id,payload,created_by) VALUES (?,?,?,?)",
         ("a", "other", json.dumps({"id": "other", "tenantId": "b"}), "operator"))
db.execute("INSERT INTO evidence_receipts(tenant_id,id,payload,created_by) VALUES (?,?,?,?)",
           ("a", "denied", json.dumps({"id": "denied", "tenantId": "a", "contractId": None, "semanticReleaseId": None, "outcome": "denied"}), "operator"))
rejected("INSERT INTO evidence_receipts(tenant_id,id,payload,created_by) VALUES (?,?,?,?)",
         ("a", "success", json.dumps({"id": "success", "tenantId": "a", "outcome": "succeeded"}), "operator"))
print("Control migration constraints passed")
