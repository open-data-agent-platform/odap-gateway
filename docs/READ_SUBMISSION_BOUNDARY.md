# Internal read submission boundary

`lib/read-submission.ts` defines an engine-independent prepared-send callback
and a small internal coordinator used by both existing BigQuery dispatch paths.
It is not a new database adapter, public execution endpoint or ODAP protocol.

## Ordering and ownership

`submitPreparedRead(prepare, claim, claimFailure?)` has three ordered steps:

1. Invoke trusted local preparation and require a send function.
2. Invoke the host's durable claim operation and require literal `true`.
3. Invoke the prepared send function once, returning its result or failure.

Preparation must not submit a warehouse job. The host, not the coordinator,
owns authorization, immutable action/semantic binding, resource policy and
atomic claim persistence. Callbacks are trusted implementation code, never
request-body values, plugins supplied by agents, or capability-inspector output.
This helper cannot verify that arbitrary callback code checks authority or
avoids network activity. It does not turn a boolean into a security credential.

The owner dispatcher retains its scoped `dispatch_priced_reads` selection and
conditional claim write, including post-preparation authority rechecks. A claim
requires `success === true` and exactly one affected row; truthy non-booleans
are refused. The delegated dispatcher retains its `claimable_delegated_reads`
selection, exact compiled-body digest and matching `RETURNING` confirmation.
Neither path changes its stored authorization predicates, byte ceiling, pending
receipt, budget reservation, or legacy-versus-delegated exclusion.

## Failure behavior

| Point | Send behavior | Durable state |
| --- | --- | --- |
| Preparation fails or returns no function | No claim or send | Existing reservation remains |
| Claim refuses current authority | No send | Host storage determines whether any write occurred |
| Claim commits but its response is lost, malformed or unconfirmed | No send | Committed claim and pending reservation are not released |
| Send fails after a confirmed claim | No automatic retry | Claim, pending evidence and reservation remain |
| Replay or concurrent contender | Only confirmed winner can send | Existing storage uniqueness and authority checks still apply |

The coordinator does not catch claim/storage exceptions, retry, refund, cancel
or settle costs. Existing path-specific outcomes remain: owner-adapter failures
propagate; the delegated sender maps uncertainty to `observation-required`.
No acknowledgment is treated as a completed query or final billing evidence.

This is an at-most-one send-attempt boundary backed by the existing claim
store, not an exactly-once provider guarantee. A committed claim can legitimately
have zero sends after response loss or process termination. A healthy positive
test must, however, demonstrate exactly one send, not merely "at most one".

## Verification and remaining scope

`tests/read-submission.test.ts` verifies the coordinator's ordering and strict
confirmation rules. `tests/read-submission-storage.test.ts` runs the same
conformance cases against both existing paths, using synthetic fixtures and
actual temporary SQLite databases. Each operation/replay opens a new connection.
Tests assert exact send/claim counts, retained funds, pending evidence, current
authorization, and rejection after ambiguous commits. No remote query is sent.

Connection replay and injected exceptions are not a real process-kill test.
Existing native D1 and path-specific regression suites remain required. This
batch does not provide a second engine, generic resource ledger, live provider
verification, cross-engine result/pagination/cancellation coverage or a pilot.
Provider-specific project/location, compilation, pricing and storage still need
separate work before another engine can use the common submission boundary.
