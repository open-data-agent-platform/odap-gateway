# Evidence coverage of recorded attempts

`readEvidenceCoverage(access)` takes one read-only SQLite snapshot and
returns counts only. An active tenant owner receives zeroes for an empty
tenant. A missing tenant, non-owner or inactive membership returns `null`,
not a zero-activity report. The inventory does not contact a warehouse or
billing provider or perform migrations.

## Reading the counts

Open **Evidence coverage** in the local Gateway footer, enter the tenant ID,
and select **View coverage**. The page shows counts, not receipt records or
money. Only a valid, balanced report with zero recorded attempts is shown as
empty. An expired session offers sign-in; denied access, unavailable storage
and malformed reports never produce zeroes. Editing the tenant, refreshing or
hiding the page clears the previous report. No tenant or report is persisted
by the component. The static HTML contains no counts or signed sessions.

The local Worker implements `GET /api/control/{tenant}/evidence-coverage`.
The in-process MCP tool `odap_evidence_coverage` accepts only
`{"tenantId":"..."}`. The host supplies the signed session separately on
each call; tool arguments, client metadata and identity headers cannot assign
ownership. Both use the [same request handler](../lib/coverage-request.ts).

An active tenant owner receives `{ok:true,coverage:{...}}`, including zeroes
for an empty tenant. Without a valid session the REST response is 401; absent,
inactive or non-owner memberships give 403, including loss of ownership
between the session check and the inventory query. A storage failure gives
503, not a zero report. REST responses are not cacheable. The MCP tool returns
the same body in its text result and sets `isError` on denial or failure.

The [MCP handler](../lib/coverage-mcp.ts) supports post-initialization
`tools/list` and `tools/call` in memory; listing reveals only a static tool
description. It is not a listening server, an OAuth integration or an
independently tested MCP client. There is no tool to execute SQL.

### Local stdio transport

A Node host can attach the [coverage transport](../scripts/coverage-stdio.ts)
to its private input/output pipes with
`serveCoverageStdio(input, output, env, sessionRequest)`. It does not open a
socket or read process credentials. The host supplies the database binding and
signed request context; nothing in the initialize message grants tenant access.

1. Send a newline-delimited UTF-8 JSON-RPC `initialize` request. Inspect the
   offered local protocol version (`2025-06-18`) and tools capability.
2. If compatible, send `notifications/initialized`, then `tools/list` or
   `tools/call`. For an incompatible version, close the pipe instead.
3. End stdin to close the session. A new pipe must negotiate independently.

Each frame is limited to 64 KiB excluding the newline. A malformed complete
JSON frame receives a parse error without its contents; an oversized frame
terminates the transport. An unterminated final frame is discarded. The
[subprocess test](../tests/coverage-stdio.test.ts) uses a synthetic session
and read-only SQLite; its fixture host is not a deployment command. It tests
this single tools profile, not general MCP conformance or external adoption.

## Interpreting the counts

There are two denominators. **Recorded attempts** are the sum of durable
missing-release refusals and admitted execution intents. **Admitted** counts
only execution intents; a pre-approval refusal is not an admission. Requests
that never reached durable storage and other classes of pre-approval refusal
are outside both counts. This is not a fraction of all inbound traffic.

Each admitted intent belongs to exactly one bucket:

| Field | Evidence present in the same tenant |
|---|---|
| `pendingOutcome` | Bound pending receipt, no recorded terminal observation, bill or settlement. A prepared job need not have been dispatched. |
| `pendingBilling` | Bound pending receipt and terminal observation on a bounded claim, but no final bill or settlement. Zero measured bytes is not a zero charge. |
| `attributedSettlements` | Bounded claim, linked pending and final receipts, matching job outcome, bill reference record and matching ledger settlement (including an explicit zero). Delegated attempts also require matching audience and claim digest across observation and bill, plus matching billed project, location and job. |
| `unattributedSettlements` | Settlement with a linked terminal receipt but no per-job bill record. This includes legacy data; it does not establish when the settlement was created. |
| `missingEvidence` | No qualifying chain, including a newly admitted intent not yet prepared or conflicting monetary links. This is a gap to inspect, not a claim of data loss. |

The five buckets sum to `admitted`. The observation lookup chooses at most
one immutable sample per intent, so byte-count enrichment, repeated
reconciliation and refusal retries do not change the denominators. A standalone
receipt or job identifier is not counted as a new attempt.

On databases migrated through 0026, an existing delegated bill with absent
or contradictory provenance is a `missingEvidence` gap, not an attributed
settlement. It differs from a settlement with **no bill row**. A second
terminal sample from a different audience also disqualifies the chain; a
second active owner or a matching byte-count enrichment does not add a job.

The first terminal sample may lack a byte count. A later count (including
zero) enriches it only if the outcome agrees. If a restored database has
both `cancelled` and `failed` for the same tenant and intent, neither
sample takes precedence. The inventory keeps the admission in its
denominator but classifies it as `missingEvidence`, before or after billing.
Settled export returns no bundle. The delegated requester-by-intent lookup
returns 503 rather than a misleading pending or final receipt. These reads
do not reverse a charge or rewrite the original receipts. The normal
insertion trigger already rejects conflicting samples.

Each linked pending or terminal receipt used for classification needs exactly
one creation event for its tenant, receipt ID and object kind `receipt`.
The actor and event time must match the receipt row's creator and database
creation time (not the timestamp inside its payload). A missing, duplicate or
mismatched event makes the admission `missingEvidence`. A legacy settlement
with no prepared job need only have the event for its linked terminal receipt.
These checks neither change the denominators nor recreate missing events.

Migration 0029 protects new ordinary SQL writes to `control_object_events`.
Existing entries cannot be updated, deleted or replaced at the same sequence.
A new receipt event must be unique for its tenant and receipt, and must
match a receipt created on the same database clock tick. The normal receipt
insert trigger does this in the same statement. Upgrading does not remove
duplicates or fill old gaps; keep a damaged copy isolated. These constraints
do not authenticate the database or prevent a privileged schema or file edit.

The attributed bucket checks relational linkage, not a signed invoice, an
independently pinned checksum, the full receipt wire shape or the presence of
every audit event. Use the [settled evidence verifier](SETTLED_EVIDENCE.md)
for a specific exported bundle. No monetary totals or tenant identifiers
are returned by this inventory.
