"""Compare recorded semantic approval withdrawals, without authorizing publication."""
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


def withdrawals(path, tenant):
    # Historical bindings must survive current membership and catalog changes.
    query = """
      SELECT w.approval_id,w.revision_id,w.withdrawn_by,w.reason,w.withdrawn_at,
             a.revision_id,a.approved_by,a.approved_at,
             r.definition_json,r.definition_digest,r.owner_id,r.provenance_ref,r.proposed_by,r.proposed_at,
             v.definition_digest,v.validated_by,v.evidence_ref,v.validated_at,
             (SELECT count(*) FROM main.semantic_release_promotions p
              WHERE p.tenant_id COLLATE BINARY=w.tenant_id
                AND (p.approval_id COLLATE BINARY=w.approval_id OR p.revision_id COLLATE BINARY=w.revision_id))
      FROM main.semantic_approval_withdrawals w LEFT JOIN main.semantic_candidate_approvals a
        ON a.tenant_id COLLATE BINARY=w.tenant_id AND a.id COLLATE BINARY=w.approval_id
      LEFT JOIN main.semantic_candidate_revisions r
        ON r.tenant_id COLLATE BINARY=w.tenant_id AND r.id COLLATE BINARY=w.revision_id
      LEFT JOIN main.semantic_candidate_validations v
        ON v.tenant_id COLLATE BINARY=w.tenant_id AND v.revision_id COLLATE BINARY=w.revision_id
      WHERE w.tenant_id=? COLLATE BINARY
    """
    with open_snapshot(path, "control_tenants", "semantic_approval_withdrawals", "semantic_candidate_approvals",
                       "semantic_candidate_revisions", "semantic_candidate_validations", "semantic_release_promotions") as db:
        if db.execute("SELECT id FROM main.control_tenants WHERE id=? COLLATE BINARY", (tenant,)).fetchmany(2) != [(tenant,)]:
            raise ValueError("missing tenant")
        rows = db.execute(query, (tenant,)).fetchmany(MAX_ROWS + 1)
    if len(rows) > MAX_ROWS:
        raise ValueError("inventory limit")
    result, revisions = {}, set()
    for row in rows:
        (approval, revision, actor, reason, at, approved_revision, approver, approved_at,
         raw, digest, owner, provenance, proposer, proposed_at, validated_digest, validator, evidence, validated_at, promotions) = row
        if (not all(text(v) for v in (approval, revision, actor, approved_revision, approver, owner, provenance, proposer, validator, evidence))
                or approval in result or revision in revisions or promotions != 0 or approved_revision != revision
                or not actor == approver == owner == validator
                or not isinstance(reason, str) or not reason.strip() or len(reason) > 1024 or "\0" in reason
                or not isinstance(raw, str) or len(raw) > 32768
                or not isinstance(digest, str) or not re.fullmatch(r"sha256:[a-f0-9]{64}", digest)
                or digest != validated_digest):
            raise ValueError("invalid withdrawal binding")
        definition = json.loads(raw, object_pairs_hook=pairs, parse_constant=invalid_constant)
        if (not isinstance(definition, dict) or definition.get("profile") != "odap.bigquery-metric.v1"
                or definition.get("tenantId") != tenant
                or not all(text(definition.get(k)) for k in ("sourceRevision", "target", "metricId"))
                or "sha256:" + hashlib.sha256(raw.encode("utf-8")).hexdigest() != digest
                or not timestamp(proposed_at) <= timestamp(validated_at) <= timestamp(approved_at) <= timestamp(at)):
            raise ValueError("invalid review history")
        revisions.add(revision)
        result[approval] = row[1:-1]
    return result


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
        old, other = withdrawals(restored, args.tenant), withdrawals(reference, args.tenant)
    except (OSError, RuntimeError, ValueError, sqlite3.Error):
        print("No comparison: unusable standalone snapshots, tenant or withdrawal bindings.", file=sys.stderr)
        return 2
    differences = dict(referenceOnly=len(other.keys() - old.keys()), restoredOnly=len(old.keys() - other.keys()),
                       changed=sum(old[k] != other[k] for k in old.keys() & other.keys()))
    different = any(differences.values())
    print(json.dumps(dict(withdrawalComparison="different" if different else "equal", **differences,
                          restored={"withdrawals": len(old)}, reference={"withdrawals": len(other)},
                          scope="recorded-tenant-approval-withdrawals-only", issuerAuthenticated=False,
                          definitionValidated=False, publicationAuthorized=False, executionAuthorized=False,
                          retryAuthorized=False, servingAuthorized=False)))
    return int(different)


if __name__ == "__main__":
    sys.exit(main())
