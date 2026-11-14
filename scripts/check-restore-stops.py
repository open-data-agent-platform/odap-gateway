"""Compare recorded pre-dispatch stops in detached snapshots. Never authorize serving."""
import argparse
from datetime import datetime
import json
from pathlib import Path
import re
import sqlite3
import sys

from restore_snapshot import distinct_snapshots, open_snapshot


MAX_ROWS = 10000


def text(value, maximum=1024):
    return (isinstance(value, str) and bool(value.strip()) and len(value) <= maximum
            and not re.search(r"[\x00-\x1f\x7f]", value))


def timestamp(value):
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z", value, re.ASCII):
        raise ValueError("invalid stop time")
    datetime.fromisoformat(value[:-1] + "+00:00")


def stops(path, tenant):
    # Historical stops survive membership, policy and release changes; do not use eligibility views.
    query = """
      SELECT s.intent_id,s.reason,s.stopped_by,s.stopped_at,
             i.contract_id,i.principal_id,i.action_digest,i.budget_id,i.reservation_id,i.reserved_units
      FROM main.dispatch_stopped_intents s LEFT JOIN main.execution_intents i
        ON i.tenant_id COLLATE BINARY=s.tenant_id AND i.id COLLATE BINARY=s.intent_id
      WHERE s.tenant_id=? COLLATE BINARY
    """
    with open_snapshot(path, "control_tenants", "dispatch_stopped_intents", "execution_intents") as db:
        if db.execute("SELECT id FROM main.control_tenants WHERE id=? COLLATE BINARY", (tenant,)).fetchmany(2) != [(tenant,)]:
            raise ValueError("missing tenant")
        rows = db.execute(query, (tenant,)).fetchmany(MAX_ROWS + 1)
    if len(rows) > MAX_ROWS:
        raise ValueError("inventory limit")
    result = {}
    counts = dict(stops=0, attributedStops=0, legacyStops=0)
    for row in rows:
        intent, reason, actor, at, contract, principal, action, budget, reservation, units = row
        if (not all(text(v) for v in (intent, reason, contract, principal, budget, reservation))
                or intent in result or not isinstance(action, str)
                or not re.fullmatch(r"sha256:[a-f0-9]{64}", action)
                or type(units) is not int or not 0 <= units <= 2**53 - 1):
            raise ValueError("invalid stop binding")
        if actor is None and at is None:
            kind = "legacyStops"
        else:
            if not text(actor, 512) or reason != "owner_requested_stop":
                raise ValueError("invalid stop attribution")
            timestamp(at)
            kind = "attributedStops"
        counts[kind] += 1
        counts["stops"] += 1
        result[intent] = row[1:]
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
        old, old_counts = stops(restored, args.tenant)
        other, other_counts = stops(reference, args.tenant)
    except (OSError, RuntimeError, ValueError, sqlite3.Error):
        print("No comparison: unusable standalone snapshots, tenant or stop bindings.", file=sys.stderr)
        return 2
    differences = dict(referenceOnly=len(other.keys() - old.keys()), restoredOnly=len(old.keys() - other.keys()),
                       changed=sum(old[k] != other[k] for k in old.keys() & other.keys()))
    different = any(differences.values())
    print(json.dumps(dict(stopComparison="different" if different else "equal", **differences,
                          restored=old_counts, reference=other_counts, scope="recorded-tenant-dispatch-stops-only",
                          issuerAuthenticated=False, cancellationConfirmed=False, executionAuthorized=False,
                          retryAuthorized=False, settlementAuthorized=False, servingAuthorized=False)))
    return int(different)


if __name__ == "__main__":
    sys.exit(main())
