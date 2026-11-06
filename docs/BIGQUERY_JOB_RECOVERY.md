# BigQuery job recovery (development)

The preview client sends `configuration.dryRun: true` on jobs.insert. An
explicit zero-byte estimate is valid; a missing, malformed or unsafe integer
estimate blocks the preview. Estimates are not final billed bytes.

The internal recovery reader in `lib/bigquery-job-recovery.ts` only looks up
jobs. Before submission, a dispatcher must use the persisted project,
location, deterministic job ID and action label on
the initial request, and never allocate a new job ID on an ambiguous retry.
The ID is stable per tenant and intent; changed action content retains that ID
but changes the expected binding label. A job label is not an authorization
credential: the job namespace and submitting identity must be controlled.

| Warehouse evidence | Reader result |
|---|---|
| Wrong target, mismatched ID/label, non-query job, dry run, malformed status, or non-404 HTTP failure | Error; not evidence of completion |
| 404 | Not found at lookup time; not authorization to resubmit |
| Pending or running | Pending; retain reservation |
| Done | Succeeded, failed or cancelled based on the final error result |
| Missing or unsupported terminal billed-byte count | Outcome known, billed bytes unknown; never assume zero |

Only job metadata is requested, not query results or SQL text. Billed bytes
are a warehouse measurement, not invoice currency, and may be informational
under capacity pricing. This reader is not a public endpoint. No live
dispatch, final receipt issuance or budget settlement is wired to it yet.

## Bounded observation transport

Both the non-delegated GET and injected delegated lookup have a 15-second
deadline covering response headers and body consumption. A successful metadata
body is limited to 256 KiB of actual bytes, independent of Content-Length.
Declared excess, invalid UTF-8, malformed JSON, missing bodies and transport
failures are rejected without returning provider body fragments. The shared
reader is also used by OAuth exchanges; their existing limits are unchanged.

Redirected responses are refused before interpreting even a 404. Other non-200
bodies, including ordinary 404s, are discarded without JSON parsing or waiting
for cancellation to finish. An ordinary 404 still means not-found, never
permission to resubmit. Late responses after the deadline are discarded. There
is no automatic retry or new terminal write after an unsuccessful lookup;
claims, existing observations, pending receipts and budget reservations remain
unchanged. Access is still rechecked before successful observation persistence.

The delegated observer receives the pinned reference and an AbortSignal. It
must remain an observation-only operation and should honor that signal. The
deadline bounds waiting even if the injected transport ignores cancellation;
it cannot undo arbitrary side effects inside a supplied callback. The regular
reader's token exchange precedes the lookup and has its own separate deadline.
These bounds do not cover credential signing, storage operations, legacy query
result bodies or jobs.insert acknowledgment bodies. Tests use synthetic providers
and local Workers/D1; no real warehouse operation or pilot acceptance is implied.

## Durable preparation

Migration 0005 adds immutable BigQuery job bindings. The internal
`prepareIntentJob` helper takes an admitted intent ID and trusted adapter
configuration. It derives the job identity from the stored action digest.
On first preparation, the database checks the active tenant owner, the
original principal's active membership and absence of a cost settlement.
The binding, linked pending evidence receipt and receipt audit event are
written in one statement. Exact retries return the original identity and
receipt, including its original timestamp; changing the project or location
conflicts. Earlier intents are not backfilled. A crash after admission but
before preparation leaves the existing reservation; it does not create a job.

For recovery, call `observePreparedIntentJob` with tenant owner access and
the intent ID. It reloads the pinned target and verifies the job identity and
receipt before the authenticated metadata lookup. The pending receipt records
preparation only, not approval to dispatch, proof of submission or the latest
warehouse outcome. It remains immutable after terminal observations. No SQL,
credentials or result rows are stored in the binding.

Tests run the actual migration and service SQL against SQLite using Python 3
(`ODAP_TEST_PYTHON` can override the executable). Warehouse HTTP is mocked.
For the internal dispatch authorization gate that follows preparation, see
[Final dispatch authorization](DISPATCH_AUTHORIZATION.md). Live warehouse
submission, final receipt issuance from trusted outcomes, and deployed tenant
tests are separate work.

## Delegated preparation

Migration 0023 adds a separate owner command for a policy-funded delegated
intent. Send same-origin signed-session JSON `{"intentId":"..."}` to
`POST /api/control/{tenant}/job-preparations`. The server's configured
delegation audience must match. Project, location, action, credentials and
cost limits are not request parameters.

The database rechecks live delegation, the requesting principal, owner,
consumed contract, reserved allowance, current target and unexpired pricing
at the write. A stopped or settled intent is ineligible. The binding records
the three inputs to the ceiling:
`min(policy byte limit, floor(reserved micro-USD * 2^40 / micro-USD per TiB))`.
The existing pending receipt and audit event commit with the binding; no funds
are reserved again. Historical jobs are not assigned inferred limits.

The first call returns 201; a retry while still eligible returns 200 with the
same `jobReference`, `receiptId`, `intentId` and `maximumBytesBilled` (a
decimal string). The Location header points to the tenant's receipt GET.
After loss of eligibility the command returns 409, even if historical
evidence exists. A 503 is not evidence that the write failed.

This prepares an identifier, not a BigQuery job. Legacy submission and
metadata-recovery helpers refuse delegated bindings before adapter or
credential use. Migration 0023 alone blocks all delegated claims; migration
0024 adds a distinct [one-time local handoff](DISPATCH_AUTHORIZATION.md#delegated-handoff-offline)
without wiring a real transport.

## Terminal observations without a bill

For a **delegated** claim, migration 0025 and
[`observeDelegatedClaim`](../lib/delegated-job-recovery.ts) use an explicitly
injected metadata lookup. There is no HTTP route, default observer, token
source or send operation. The observer receives the persisted job
reference and an AbortSignal, not SQL or an executable request. A successful metadata response must match project, region, job ID,
action label, query type and claimed byte ceiling; a dry run is not execution.
The stored digest links evidence to the original claim; it is not a signature
from the warehouse.

Recovery requires a current owner of the tenant and the original audience.
It remains possible after delegation revocation: an owner is investigating an
already-claimed action, not asking to execute it. Access is checked again at
write and readback, including after a nonterminal lookup. A prepared job with
no confirmed claim is not eligible.

| Observation | What survives a restart |
|---|---|
| 404 or pending/running | No new terminal record. Return stronger stored evidence if present; never retry submission. |
| Matched terminal outcome, bytes unknown | Record the outcome once. Missing, malformed or out-of-range bytes are unknown, not zero. |
| Same outcome, known bytes | Append the first known count, including explicit zero. Repeats do not change the witness; conflicting counts or outcomes fail. |
| Unmatched metadata, lookup failure or malformed status | No new evidence or budget changes. |

`readDelegatedRecovery` needs no observer: it returns the original job and
pending receipt reference plus the strongest verified terminal observation,
or null for the observation when none exists. This also recovers a committed
observation after a lost write acknowledgement. Pre-0025 delegated terminal
rows lacking claim provenance are retained unchanged; this path refuses to
adopt or overwrite them. Terminal bytes are not a monetary bill, and even a
successful observation does not release the reservation or rewrite the receipt.

The separate [delegated settlement](COST_SETTLEMENT.md#delegated-job-settlement)
step requires an attributable final monetary charge, not a byte count.

### Non-delegated recovery

`reconcileTerminalObservation(access, intentId, env)` is an internal operation.
It checks the immutable job binding, pending receipt and dispatch claim before
looking up metadata. The returned project, location, job ID, action label and
query byte ceiling must match. A legacy claim without a ceiling is ineligible;
migration 0008 adds no historical outcomes.

The first terminal observation stores the outcome, optional billed bytes,
observing tenant owner and database timestamp. If bytes were unknown, a later
sample with the same outcome may append the first known count (including zero).
Conflicting outcomes or known counts are rejected, not overwritten. Membership
is checked again under the write lock. Concurrent identical readings are safe.
Pending and not-found responses add nothing and never erase earlier evidence.
Lookup failures propagate; callers can still use `readTerminalObservation`
to read the most informative saved sample without contacting the warehouse.

This record is operational evidence, **not a final monetary receipt**. Neither
operation resubmits a job, returns query results, converts bytes to money,
releases reserved funds or changes the pending Evidence Receipt. Authoritative
billing reconciliation is a [separate internal step](COST_SETTLEMENT.md#bounded-bigquery-jobs-local-engineering),
exercised locally with synthetic monetary evidence.

References: [BigQuery Job](https://cloud.google.com/bigquery/docs/reference/rest/v2/Job)
and [jobs.get](https://cloud.google.com/bigquery/docs/reference/rest/v2/jobs/get).
