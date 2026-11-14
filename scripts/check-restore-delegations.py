"""Compare recorded delegation history in detached snapshots, without restoring authority."""
import argparse
from datetime import datetime
import json
from pathlib import Path
import re
import sqlite3
import sys

from restore_snapshot import distinct_snapshots, open_snapshot


MAX_ROWS = 10000
TABLES = {
    "keys": ("agent_verification_keys", "agent_id,key_id,public_hex,active", ("agent_id", "key_id")),
    "requests": ("contract_requests", "principal_id,id,release_id,requested_agent_id,action_digest,requested_at", ("principal_id", "id")),
    "grants": ("contract_human_grants", "id,requester_id,request_id,granted_by,policy_revision,project_id,location,granted_at,expires_at", ("id",)),
    "delegations": ("agent_delegations", "id,grant_id,audience,agent_id,key_id,revoked_at", ("id",)),
    "proofs": ("agent_delegation_proofs", "delegation_id,verified_at", ("delegation_id",)),
}


def text(value, maximum=1024):
    return (isinstance(value, str) and bool(value.strip()) and len(value) <= maximum
            and not re.search(r"[\x00-\x1f\x7f]", value))


def timestamp(value):
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z", value, re.ASCII):
        raise ValueError("invalid chronology")
    return datetime.fromisoformat(value[:-1] + "+00:00")


def inventory(db, table, columns, identity, tenant):
    # Only these fixed table/column names enter SQL. Tenant values are bound exactly.
    rows = db.execute(f"SELECT {columns} FROM main.{table} WHERE tenant_id=? COLLATE BINARY",
                      (tenant,)).fetchmany(MAX_ROWS + 1)
    if len(rows) > MAX_ROWS:
        raise ValueError("inventory limit")
    result = {}
    for values in rows:
        row = dict(zip(columns.split(","), values))
        for field, value in row.items():
            if field == "active":
                if type(value) is not int or value not in (0, 1):
                    raise ValueError("invalid key state")
            elif field == "revoked_at" and value is None:
                continue
            elif not text(value):
                raise ValueError("invalid binding")
        key = tuple(row[field] for field in identity)
        if key in result:
            raise ValueError("duplicate identity")
        result[key] = row
    return result


def unique(rows, fields):
    if len({tuple(row[field] for field in fields) for row in rows.values()}) != len(rows):
        raise ValueError("duplicate reference")


def snapshot(path, tenant):
    with open_snapshot(path, "control_tenants", *(entry[0] for entry in TABLES.values())) as db:
        if db.execute("SELECT id FROM main.control_tenants WHERE id=? COLLATE BINARY", (tenant,)).fetchmany(2) != [(tenant,)]:
            raise ValueError("missing tenant")
        tables = {name: inventory(db, *entry, tenant) for name, entry in TABLES.items()}
    keys, requests, grants, delegations, proofs = (tables[name] for name in TABLES)
    unique(keys, ("public_hex",))
    unique(grants, ("requester_id", "request_id"))
    unique(delegations, ("grant_id",))
    for row in keys.values():
        if not re.fullmatch(r"04[a-f0-9]{128}", row["public_hex"]):
            raise ValueError("invalid public point encoding")
    for row in requests.values():
        if not re.fullmatch(r"sha256:[a-f0-9]{64}", row["action_digest"]):
            raise ValueError("invalid action digest")
        timestamp(row["requested_at"])
    for row in grants.values():
        request = requests.get((row["requester_id"], row["request_id"]))
        if (not request or row["requester_id"] == row["granted_by"]
                or not re.fullmatch(r"[a-z][a-z0-9:.-]{4,127}", row["project_id"], re.IGNORECASE | re.ASCII)
                or not re.fullmatch(r"[a-z0-9-]{1,64}", row["location"], re.IGNORECASE | re.ASCII)
                or timestamp(row["granted_at"]) < timestamp(request["requested_at"])
                or timestamp(row["expires_at"]) <= timestamp(row["granted_at"])):
            raise ValueError("invalid human grant binding")
    for row in delegations.values():
        grant = grants.get((row["grant_id"],))
        if (not grant or (row["agent_id"], row["key_id"]) not in keys
                or row["agent_id"] != requests[(grant["requester_id"], grant["request_id"])]["requested_agent_id"]):
            raise ValueError("invalid delegation binding")
        if row["revoked_at"] is not None and timestamp(row["revoked_at"]) < timestamp(grant["granted_at"]):
            raise ValueError("invalid revocation chronology")
    for row in proofs.values():
        delegation = delegations.get((row["delegation_id"],))
        if not delegation:
            raise ValueError("unbound proof")
        grant = grants[(delegation["grant_id"],)]
        at = timestamp(row["verified_at"])
        if (not timestamp(grant["granted_at"]) <= at < timestamp(grant["expires_at"])
                or (delegation["revoked_at"] is not None and at > timestamp(delegation["revoked_at"]))):
            raise ValueError("invalid proof chronology")
    counts = {name: len(rows) for name, rows in tables.items()}
    counts.update(disabledKeys=sum(row["active"] == 0 for row in keys.values()),
                  revokedDelegations=sum(row["revoked_at"] is not None for row in delegations.values()))
    return tables, counts


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--restored", required=True, type=Path)
    parser.add_argument("--reference", required=True, type=Path)
    parser.add_argument("--tenant", required=True)
    args = parser.parse_args()
    try:
        if not text(args.tenant, 256):
            raise ValueError("invalid tenant")
        restored, reference = distinct_snapshots(args.restored, args.reference)
        old, old_counts = snapshot(restored, args.tenant)
        other, other_counts = snapshot(reference, args.tenant)
    except (OSError, RuntimeError, ValueError, sqlite3.Error):
        print("No comparison: unusable standalone snapshots, tenant or delegation bindings.", file=sys.stderr)
        return 2
    differences = {name: dict(referenceOnly=len(other[name].keys() - rows.keys()),
                              restoredOnly=len(rows.keys() - other[name].keys()),
                              changed=sum(rows[k] != other[name][k] for k in rows.keys() & other[name].keys()))
                   for name, rows in old.items()}
    different = any(value for counts in differences.values() for value in counts.values())
    print(json.dumps(dict(delegationComparison="different" if different else "equal", differences=differences,
                          restored=old_counts, reference=other_counts, scope="recorded-tenant-delegation-history-only",
                          issuerAuthenticated=False, signatureVerified=False, executionAuthorized=False,
                          retryAuthorized=False, servingAuthorized=False)))
    return int(different)


if __name__ == "__main__":
    sys.exit(main())
