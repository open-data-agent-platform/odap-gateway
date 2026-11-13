"""Compare recorded cancellation requests in two detached Gateway snapshots."""
import argparse
from datetime import datetime
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import sys

from restore_snapshot import distinct_snapshots, open_snapshot


MAX_ROWS = 10000


def text(value):
    return (isinstance(value, str) and bool(value.strip()) and len(value) <= 1024
            and not re.search(r"[\x00-\x1f\x7f]", value))


def digest(value):
    return isinstance(value, str) and re.fullmatch(r"sha256:[a-f0-9]{64}", value) is not None


def timestamp(value):
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z", value, re.ASCII):
        raise ValueError("invalid chronology")
    return datetime.fromisoformat(value[:-1] + "+00:00")


def identity(*fields):
    return hashlib.sha256(json.dumps(fields, ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()


def requests(path, tenant):
    # Never start from current eligibility: revocation cannot erase an old request.
    query = """
      SELECT r.intent_id,r.job_id,r.requested_by,r.requested_at,r.delegation_audience,r.claim_body_digest,
             h.claimed_by,h.claimed_at,h.maximum_bytes_billed,h.delegation_audience,h.compiled_body_digest,
             b.delegation_audience,b.project_id,b.location,b.job_id,b.action_tag,b.receipt_id,
             i.action_digest,i.contract_id
      FROM main.bigquery_cancellation_requests r
      LEFT JOIN main.dispatch_claims h ON h.tenant_id COLLATE BINARY=r.tenant_id AND h.intent_id COLLATE BINARY=r.intent_id
      LEFT JOIN main.bigquery_job_bindings b ON b.tenant_id COLLATE BINARY=r.tenant_id AND b.intent_id COLLATE BINARY=r.intent_id
      LEFT JOIN main.execution_intents i ON i.tenant_id COLLATE BINARY=r.tenant_id AND i.id COLLATE BINARY=r.intent_id
      WHERE r.tenant_id=? COLLATE BINARY
    """
    with open_snapshot(path, "control_tenants", "bigquery_cancellation_requests", "dispatch_claims",
                       "bigquery_job_bindings", "execution_intents") as db:
        if db.execute("SELECT id FROM main.control_tenants WHERE id=? COLLATE BINARY", (tenant,)).fetchmany(2) != [(tenant,)]:
            raise ValueError("missing tenant")
        rows = db.execute(query, (tenant,)).fetchmany(MAX_ROWS + 1)
    if len(rows) > MAX_ROWS:
        raise ValueError("inventory limit")
    result = {}
    counts = dict(requests=0, attributedDelegatedRequests=0, unattributedDelegatedRequests=0, nonDelegatedRequests=0)
    for row in rows:
        (intent, requested_job, actor, at, audience, body, claimant, claimed_at, cap, claim_audience, claim_body,
         binding_audience, project, location, job, tag, receipt, action, contract) = row
        if (not all(text(v) for v in (intent, actor, claimant, project, location, contract))
                or not digest(action) or intent in result
                or type(cap) is not int or not 0 < cap <= 2**53 - 1
                or not re.fullmatch(r"[a-z][a-z0-9:.-]{4,127}", project, re.IGNORECASE | re.ASCII)
                or not re.fullmatch(r"[a-z0-9-]{1,64}", location, re.IGNORECASE | re.ASCII)
                or claim_audience != binding_audience):
            raise ValueError("inconsistent claim binding")
        expected_job = "odap_" + identity("odap.job.v1", tenant, intent)
        if (job != expected_job or requested_job != job or receipt != "pending_" + job
                or tag != identity("odap.action.v1", job, action)[:48]
                or timestamp(at) < timestamp(claimed_at)):
            raise ValueError("inconsistent request binding")
        if claim_audience is None:
            if claim_body is not None or audience is not None or body is not None:
                raise ValueError("unexpected delegated attribution")
            kind = "nonDelegatedRequests"
        else:
            if not text(claim_audience) or not digest(claim_body):
                raise ValueError("incomplete delegated claim")
            if audience is None and body is None:
                kind = "unattributedDelegatedRequests"
            elif audience == claim_audience and body == claim_body:
                kind = "attributedDelegatedRequests"
            else:
                raise ValueError("inconsistent request attribution")
        counts[kind] += 1
        counts["requests"] += 1
        result[intent] = row[1:]
    return result, counts


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--restored", required=True, type=Path)
    parser.add_argument("--reference", required=True, type=Path)
    parser.add_argument("--tenant", required=True)
    args = parser.parse_args()
    try:
        if not text(args.tenant) or len(args.tenant) > 256:
            raise ValueError("invalid tenant")
        restored, reference = distinct_snapshots(args.restored, args.reference)
        old, old_counts = requests(restored, args.tenant)
        other, other_counts = requests(reference, args.tenant)
    except (OSError, RuntimeError, ValueError, sqlite3.Error):
        print("No comparison: unusable standalone snapshots, tenant or cancellation bindings.", file=sys.stderr)
        return 2
    differences = dict(referenceOnly=len(other.keys() - old.keys()), restoredOnly=len(old.keys() - other.keys()),
                       changed=sum(old[k] != other[k] for k in old.keys() & other.keys()))
    different = any(differences.values())
    print(json.dumps(dict(requestComparison="different" if different else "equal", **differences,
                          restored=old_counts, reference=other_counts, scope="recorded-tenant-cancellation-requests-only",
                          issuerAuthenticated=False, cancellationConfirmed=False, retryAuthorized=False, servingAuthorized=False)))
    return int(different)


if __name__ == "__main__":
    sys.exit(main())
