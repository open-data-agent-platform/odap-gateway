"""Compare one acknowledged source prefix with a detached local delivery sink."""
import argparse
import json
from pathlib import Path
import re
import sqlite3
import sys

from restore_snapshot import distinct_snapshots, open_snapshot


def unique_fields(pairs):
    result = dict(pairs)
    if len(result) != len(pairs):
        raise ValueError("ambiguous payload")
    return result


def sink_rows(db, tenant, consumer, checkpoint, report):
    rows = db.execute("""SELECT seq,payload FROM accepted
        WHERE tenant=? COLLATE BINARY AND consumer=? COLLATE BINARY
        ORDER BY CAST(seq AS INTEGER)""", (tenant, consumer))
    previous = None
    for key, raw in rows:
        if not isinstance(key, str) or len(key) > 20:
            raise ValueError("invalid key")
        seq = int(key)
        if (str(seq) != key or not -(1 << 63) <= seq < (1 << 63)
                or (previous is not None and seq <= previous)):
            raise ValueError("invalid or duplicate key")
        previous = seq
        if seq > checkpoint:
            report["sinkBeyondCheckpoint"] += 1
            continue
        if not isinstance(raw, str):
            raise ValueError("invalid payload")
        event = json.loads(raw, object_pairs_hook=unique_fields)
        if not isinstance(event, dict):
            raise ValueError("invalid payload")
        yield seq, event


def source_rows(db, tenant, consumer, checkpoint):
    rows = db.execute("""SELECT sequence,object_kind,object_id,actor,recorded_at
        FROM control_object_events WHERE tenant_id=? COLLATE BINARY AND sequence<=?
        ORDER BY sequence""", (tenant, checkpoint))
    previous = None
    for seq, kind, obj, actor, time in rows:
        if (type(seq) is not int or (previous is not None and seq <= previous)
                or not all(isinstance(v, str) for v in (kind, obj, actor, time))):
            raise ValueError("invalid source event")
        previous = seq
        yield seq, dict(tenantId=tenant, consumerId=consumer, sequence=str(seq),
                        objectKind=kind, objectId=obj, actor=actor, recordedAt=time)


def compare(source, sink, tenant, consumer):
    checkpoints = source.execute("""SELECT p.sequence FROM control_audit_checkpoints p
        WHERE p.tenant_id=? COLLATE BINARY AND p.consumer_id=? COLLATE BINARY
        AND EXISTS (SELECT 1 FROM control_tenants t WHERE t.id=p.tenant_id)
        AND EXISTS (SELECT 1 FROM control_object_events e
                    WHERE e.tenant_id=p.tenant_id AND e.sequence=p.sequence)""",
                                 (tenant, consumer)).fetchmany(2)
    if len(checkpoints) != 1 or type(checkpoints[0][0]) is not int:
        raise ValueError("no usable checkpoint")
    checkpoint = checkpoints[0][0]
    report = dict(matching=0, missingAtSink=0, unexpectedAtSink=0, changed=0,
                  sinkBeyondCheckpoint=0, resumeAuthorized=False)
    expected = source_rows(source, tenant, consumer, checkpoint)
    observed = sink_rows(sink, tenant, consumer, checkpoint, report)
    left, right = next(expected, None), next(observed, None)
    while left is not None or right is not None:
        if right is None or (left is not None and left[0] < right[0]):
            report["missingAtSink"] += 1
            left = next(expected, None)
        elif left is None or right[0] < left[0]:
            report["unexpectedAtSink"] += 1
            right = next(observed, None)
        else:
            report["matching" if left[1] == right[1] else "changed"] += 1
            left, right = next(expected, None), next(observed, None)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--restored", required=True, type=Path)
    parser.add_argument("--sink", required=True, type=Path)
    parser.add_argument("--tenant", required=True)
    parser.add_argument("--consumer", required=True)
    args = parser.parse_args()
    try:
        if not args.tenant or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", args.consumer):
            raise ValueError("invalid scope")
        restored, retained = distinct_snapshots(args.restored, args.sink)
        with open_snapshot(restored, "control_tenants", "control_audit_checkpoints", "control_object_events") as src:
            with open_snapshot(retained, "accepted") as sink:
                report = compare(src, sink, args.tenant, args.consumer)
    except (OSError, ValueError, RuntimeError, sqlite3.Error):
        print("No comparison: unusable snapshots, scope, checkpoint or event.", file=sys.stderr)
        return 2
    differs = any(report[k] for k in ("missingAtSink", "unexpectedAtSink", "changed"))
    print(json.dumps(dict(report, acknowledgedPrefix="different" if differs else "equal")))
    return int(differs)


if __name__ == "__main__":
    sys.exit(main())
