# Local control audit delivery

`deliverNextControlEvent(access, consumerId, accept)` offers **one** stored
control-object event to a trusted sink. It reads existing events as well as
new ones; migration 0031 does not backfill or synthesize events. It is an
internal primitive, not a running dispatcher, HTTP route or MCP tool.

Use a server-derived owner access context and a stable consumer ID for a
single sink and source database lineage. The read checks active ownership
with the cursor and event in one snapshot. The sink receives event metadata
(including private actor and object identifiers), not the underlying object
payload. Sequence is a decimal string: keep all 64 bits. The sequence is
global to the database; gaps inside one tenant are normal.

The sink must durably save the event before returning its
`{tenantId, consumerId, sequence}` key. Deduplicate on that key and reject
a duplicate with different content. Only after a matching acknowledgment
does the producer conditionally advance the cursor, rechecking ownership
and the next tenant event in the write. Never accept a caller-selected
destination, cursor position or success claim.

| Result | Consumer action |
|---|---|
| `acknowledged` | Continue from the stored checkpoint. |
| `idle` | No next event in this authorized snapshot. Poll again later. |
| `cursor_changed` | Another worker may have advanced the cursor. Reread; do not infer which invocation delivered the event. |
| Exception or process death | Resolve any access/storage failure, then resume the same consumer. Never guess or increment a cursor. |

The source and sink do not share a transaction. If the sink commits and
the consumer dies before the source commits, the sink will see that event
again. This is at-least-once delivery **when consumption resumes**; no
background retry, exactly-once external effect, independent custody or
cross-restore continuity is claimed. Do not reuse a checkpoint with a
replacement sink, a restored copy or an unrelated source without reconciliation.

The [process-death test](../tests/control-audit-delivery.test.ts) uses a
separate local SQLite sink. Its child consumer exits after the durable sink
commit; a new process replays the same event and drains the remaining row.
No network destination is involved.

## Compare a restored checkpoint

Keep both inputs detached, closed and from the intended source/sink pair.
The restored source needs migration 0031. The sink snapshot must use the
local SQLite consumer's `accepted(tenant, consumer, seq, payload, attempts)`
layout. Never point the checker at a live database.

```sh
python -B scripts/check-restore-audit-prefix.py --restored restored.sqlite --sink retained-sink.sqlite --tenant demo --consumer archive
```

For one tenant and consumer, the checker compares every source event up to
and including its stored acknowledgment, using the exact integer key and
the delivered JSON fields (not JSON serialization order or retry count).
An interleaved event from another tenant is not a gap. Keys beyond the
checkpoint are counted separately, not content-verified: a crash after a
sink commit can legitimately leave such a key. A count alone cannot explain
why it is ahead.

| Exit | Meaning |
|---|---|
| 0 | Acknowledged prefix equal; inspect `sinkBeyondCheckpoint` separately. |
| 1 | Prefix differs. Counts distinguish missing, unexpected and changed events. Keep both copies for investigation. |
| 2 | No comparison: e.g. absent checkpoint, unusable input, malformed key or unreadable event. No success report. |

The CLI opens both snapshots read-only and neither replays an event nor moves
a cursor. It emits no identifiers or payloads. A match cannot establish
independent custody, source lineage, or the absence of events lost from
both copies. No exit status authorizes resuming delivery.
