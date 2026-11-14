"""Compare recorded release retirements in detached snapshots. Never restore authority."""
import argparse
from datetime import datetime
import json
from pathlib import Path
import re
import sqlite3
import sys

from restore_snapshot import distinct_snapshots, open_snapshot


MAX_ROWS = 10000
RELEASE_FIELDS = {"id", "tenantId", "schemaVersion", "state", "owner", "definitionDigest", "sourceRevision"}


def text(value, maximum=1024):
    return (isinstance(value, str) and bool(value.strip()) and len(value) <= maximum
            and not re.search(r"[\x00-\x1f\x7f]", value))


def timestamp(value):
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z", value, re.ASCII):
        raise ValueError("invalid time")
    return datetime.fromisoformat(value[:-1] + "+00:00")


def pairs(values):
    result = {}
    for key, value in values:
        if key in result:
            raise ValueError("duplicate field")
        result[key] = value
    return result


def invalid_constant(_):
    raise ValueError("invalid JSON constant")


def retirements(path, tenant):
    # Read durable history, not the current-owner or current-release eligibility views.
    query = """
      SELECT d.release_id,d.reason,d.retired_by,d.retired_at,r.payload,r.created_by,r.created_at
      FROM main.dispatch_retired_releases d LEFT JOIN main.semantic_releases r
        ON r.tenant_id COLLATE BINARY=d.tenant_id AND r.id COLLATE BINARY=d.release_id
      WHERE d.tenant_id=? COLLATE BINARY
    """
    with open_snapshot(path, "control_tenants", "dispatch_retired_releases", "semantic_releases") as db:
        if db.execute("SELECT id FROM main.control_tenants WHERE id=? COLLATE BINARY", (tenant,)).fetchmany(2) != [(tenant,)]:
            raise ValueError("missing tenant")
        rows = db.execute(query, (tenant,)).fetchmany(MAX_ROWS + 1)
    if len(rows) > MAX_ROWS:
        raise ValueError("inventory limit")
    result, counts = {}, dict(retirements=0, attributedRetirements=0, legacyRetirements=0)
    for release_id, reason, actor, at, payload, creator, created in rows:
        if (not all(text(v) for v in (release_id, creator)) or release_id in result
                or not isinstance(reason, str) or not reason.strip() or len(reason) > 1024 or "\0" in reason
                or not isinstance(payload, str) or len(payload) > 65536):
            raise ValueError("invalid retirement binding")
        release = json.loads(payload, object_pairs_hook=pairs, parse_constant=invalid_constant)
        if (not isinstance(release, dict) or set(release) != RELEASE_FIELDS
                or not all(text(v) for v in release.values())
                or release["schemaVersion"] != "0.1" or release["state"] not in ("released", "deprecated", "revoked")
                or release["id"] != release_id or release["tenantId"] != tenant
                or not re.fullmatch(r"sha256:[a-f0-9]{64}", release["definitionDigest"])):
            raise ValueError("invalid release binding")
        created_at = timestamp(created)
        if actor is None and at is None:
            kind = "legacyRetirements"
        else:
            if (not text(actor, 512) or actor != release["owner"] or release["state"] != "released"
                    or timestamp(at) < created_at):
                raise ValueError("invalid retirement attribution")
            kind = "attributedRetirements"
        counts[kind] += 1
        counts["retirements"] += 1
        result[release_id] = (reason, actor, at, release, creator, created)
    return result, counts


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
        old, old_counts = retirements(restored, args.tenant)
        other, other_counts = retirements(reference, args.tenant)
    except (OSError, RuntimeError, ValueError, RecursionError, sqlite3.Error):
        print("No comparison: unusable standalone snapshots, tenant or retirement bindings.", file=sys.stderr)
        return 2
    differences = dict(referenceOnly=len(other.keys() - old.keys()), restoredOnly=len(old.keys() - other.keys()),
                       changed=sum(old[k] != other[k] for k in old.keys() & other.keys()))
    different = any(differences.values())
    print(json.dumps(dict(retirementComparison="different" if different else "equal", **differences,
                          restored=old_counts, reference=other_counts, scope="recorded-tenant-release-retirements-only",
                          issuerAuthenticated=False, cancellationConfirmed=False, executionAuthorized=False,
                          retryAuthorized=False, settlementAuthorized=False, servingAuthorized=False)))
    return int(different)


if __name__ == "__main__":
    sys.exit(main())
