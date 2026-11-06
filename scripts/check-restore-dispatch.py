"""Compare claimed jobs in two detached Gateway databases. Not a dispatch or retry gate."""
import argparse
import json
from pathlib import Path
import re
import sqlite3
import sys

from restore_snapshot import distinct_snapshots, open_snapshot


def claims(path):
    # Start from claims, not a live eligibility view: revocation cannot erase a historical handoff.
    query = """
      SELECT h.tenant_id,h.intent_id,h.claimed_by,h.claimed_at,h.maximum_bytes_billed,
             h.delegation_audience,h.compiled_body_digest,b.delegation_audience,
             b.project_id,b.location,b.job_id,b.action_tag,b.receipt_id,i.action_digest,i.contract_id
      FROM main.dispatch_claims h
      LEFT JOIN main.bigquery_job_bindings b ON (b.tenant_id,b.intent_id)=(h.tenant_id,h.intent_id)
      LEFT JOIN main.execution_intents i ON (i.tenant_id,i.id)=(h.tenant_id,h.intent_id)
    """
    result = {}
    with open_snapshot(path, "dispatch_claims", "bigquery_job_bindings", "execution_intents") as db:
        for row in db.execute(query):
            tenant, intent, actor, at, cap, audience, digest, binding_audience, project, loc, job, tag, receipt, action, contract = row
            key = tenant, intent
            if (not all(isinstance(s, str) and s.strip() for s in
                        (tenant, intent, actor, at, project, loc, job, tag, receipt, action, contract))
                    or not re.fullmatch(r"odap_[0-9a-f]{64}", job)
                    or not re.fullmatch(r"[0-9a-f]{48}", tag)
                    or receipt != "pending_" + job or key in result
                    or (cap is not None and (type(cap) is not int or not 0 < cap <= 2**53 - 1))
                    or audience != binding_audience):
                raise ValueError("inconsistent claim binding")
            if audience is None:
                if digest is not None:
                    raise ValueError("unexpected delegated digest")
            elif (not isinstance(audience, str) or not audience.strip() or cap is None
                  or not isinstance(digest, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", digest)):
                raise ValueError("incomplete delegated claim")
            result[key] = row[2:]
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--restored", required=True, type=Path)
    parser.add_argument("--reference", required=True, type=Path)
    args = parser.parse_args()
    try:
        restored, reference = distinct_snapshots(args.restored, args.reference)
        old, other = claims(restored), claims(reference)
    except (OSError, RuntimeError, ValueError, sqlite3.Error):
        print("No comparison: expected two distinct standalone snapshots with readable claim bindings.", file=sys.stderr)
        return 2
    counts = {"referenceOnly": len(other.keys() - old.keys()), "restoredOnly": len(old.keys() - other.keys()),
              "changed": sum(old[k] != other[k] for k in old.keys() & other.keys())}
    different = any(counts.values())
    print(json.dumps({"claimComparison": "different" if different else "equal", **counts,
                      "warehouseSubmission": "not_verified", "retryAuthorized": False}))
    return 1 if different else 0


if __name__ == "__main__":
    sys.exit(main())
