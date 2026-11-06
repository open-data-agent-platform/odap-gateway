"""Compare active grants in two detached Gateway SQLite snapshots. Never authorize serving."""
import argparse
import json
from pathlib import Path
import sqlite3
import sys

from restore_snapshot import distinct_snapshots, open_snapshot


def active_grants(path):
    with open_snapshot(path, "control_memberships") as db:
        grants = {}
        for tenant, principal, role, active in db.execute(
                "SELECT tenant_id, principal_id, role, active FROM main.control_memberships"):
            key = (tenant, principal)
            if (not all(isinstance(s, str) and s.strip() for s in key)
                    or role not in ("reader", "reviewer", "owner")
                    or type(active) is not int or active not in (0, 1) or key in grants):
                raise ValueError("invalid membership row")
            grants[key] = role if active else None
    return {key: role for key, role in grants.items() if role is not None}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--restored", required=True, type=Path)
    parser.add_argument("--reference", required=True, type=Path,
                        help="separately obtained current membership snapshot")
    args = parser.parse_args()
    try:
        restored, reference = distinct_snapshots(args.restored, args.reference)
        old, current = active_grants(restored), active_grants(reference)
    except (OSError, RuntimeError, ValueError, sqlite3.Error):
        print("Could not compare two distinct standalone membership snapshots.", file=sys.stderr)
        return 2

    counts = {"restoredOnly": len(old.keys() - current.keys()),
              "referenceOnly": len(current.keys() - old.keys()),
              "differentRole": sum(old[k] != current[k] for k in old.keys() & current.keys())}
    different = any(counts.values())
    print(json.dumps({"membershipComparison": "different" if different else "equal",
                      **counts, "servingAuthorized": False}))
    return 1 if different else 0


if __name__ == "__main__":
    sys.exit(main())
