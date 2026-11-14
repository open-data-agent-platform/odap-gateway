# Final dispatch authorization (development)

A pending receipt proves that a job was prepared, not that it may run.
Migration 0006 adds an internal gate for **one metric read on one prepared
BigQuery job**. It changes no public endpoint and enables no tenant by default.

1. At contract issuance, bind the exact target, metric ID and scalar parameters
   using `bindMetricRead`. The SHA-256 digest uses the local
   `odap.metric-read.v1` profile. Historic arbitrary digests are not upgraded.
2. A trusted operator maintains the current target mapping (active release,
   policy/source revisions, project/location) and explicit, revision-scoped
   principal/agent read grants in D1. Removing a grant withdraws permission;
   changing the active release or revision requires new approval. Retire a
   release for the whole tenant via `dispatch_retired_releases`; stop an
   admitted but unclaimed intent via `stopBeforeDispatch` (see below). Stopping an
   intent does not rewrite the consumed contract. No public config writer or
   external IAM/catalog synchronizer is shipped.
3. An authenticated server integration calls `dispatchPreparedMetricRead`
   with verified operator access and delegated subject/agent identity. **Do
   not trust subject IDs, adapter configuration or permissions from a client.**
   The gate checks the stored job and pending evidence, validates both
   versioned snapshots and hashes the exact proposed action. Its trusted
   definition loader resolves the tenant and release ID. The [metric
   compiler](METRIC_COMPILER.md) verifies the returned definition against the
   release digest and builds the parameterized query before claiming.
4. A single conditional write rechecks both memberships, the explicit grant,
   current target and release, policy and source revisions, original action,
   contract consumption by this intent, database-time expiry, budget overrun,
   reservation, non-settlement, stop records and an unexpired scan policy
   (migration 0007). Only a newly inserted claim
   permits handoff. No grant, mismatch, stale evidence, storage failure or
   existing claim means no adapter call. Earlier reservations remain held.

The trusted adapter gets only the compiled query configuration with an explicit
[reservation-derived byte ceiling](BIGQUERY_SCAN_LIMITS.md), the validated
semantic release and the exact pinned job identity, not caller-supplied SQL.
Transport preparation takes place before the final write. Only the returned
send function can be invoked after the claim. The internal
`dispatchBigQueryMetricRead` wrapper also requires a positive operator byte
limit; the smaller ceiling is both recorded and sent.
The claim is the local decision time, **not** proof of warehouse acceptance.
A revocation committed before the claim prevents handoff. A revocation after
the claim cannot atomically retract an external request. Crash or timeout
after claiming is ambiguous: **observe the same job, do not resubmit**. Even
a 404 does not rearm a claim. Post-claim cancellation and abandoned-reservation
resolution are separate operations.

## Delegated handoff (offline)

After migration 0024, the internal `handoffDelegatedRead` accepts a verified
operator, delegated subject and audience, intent ID, structured metric action
and an explicitly injected sender. There is no HTTP route, transport default
or credential lookup. The legacy BigQuery transport still refuses delegated
bindings. Historical claims gain no inferred audience or digest.

The compiler uses the stored promoted definition, not SQL from the caller.
The final conditional insert rechecks live authority, the original
reservation, project/location, pricing, stop state and the exact snapshots
used for compilation. SQLite independently recomputes the funded byte cap
with integer arithmetic. A unique claim binds the operator and the digest
of the exact serialized job body; SQL and parameter values are not logged
in the claim. The digest identifies bytes, not warehouse execution.

Only confirmation of that insert permits a single callback. A concurrent
stop or revocation that wins before the claim prevents the call; after a
claim neither retracts it. An uncertain storage response never calls the
sender. If the sender throws, the result is `observation-required` for the
original job. Neither case rearms the claim, releases funds or replaces the
pending receipt. `handed-off` means the callback returned, not that any remote
service accepted a job. [Delegated observation-only recovery](BIGQUERY_JOB_RECOVERY.md#terminal-observations-without-a-bill)
is a separate offline-tested step and cannot resubmit the job.

## Stop before dispatch

`stopBeforeDispatch(access, intentId)` is an internal operation for an
authenticated, active owner of the same tenant. The intent must already be
admitted, but need not yet have a prepared job. Migration 0011 serializes
the stop with the final dispatch claim: an existing claim prevents a new
stop, and an existing stop prevents a new claim. A new stop records the first
owner, a fixed reason and the database time. Retries do not reattribute it.
The caller receives one of the following results after an owner-scoped read:

| Result | Meaning |
|---|---|
| `stopped` | An attributed local stop exists and no claim or settlement was found. The adapter cannot receive a new handoff for this intent. |
| `already-claimed` | The claim exists, including after an ambiguous timeout. Do not resubmit; observe the originally bound job. |
| `already-settled` | A settlement already exists and no claim was found. No new stop was recorded. |
| `legacy-stop` | A historical marker exists without actor/time and without a claim or settlement. Its provenance is not backfilled. |

Absent intents and insufficient membership fail without returning state. A
claim takes precedence even if an older database contains both a claim and
a stop. A stop is not a warehouse cancellation, a terminal Evidence Receipt
or evidence of zero cost. It does not release reserved funds, change the
consumed contract, or rewrite a pending receipt.

`POST /api/control/{tenant}/dispatch-stops` (under the configured mount) accepts
exactly `{ "intentId": "..." }` from a signed session with current tenant-owner
membership and exact same-origin JSON. The body is bounded to 2 KiB with the
shared timeout/abort guard. The database checks ownership again at the write;
the response is based on an owner-scoped read, never the attempted insert alone.
Success acknowledges the original `stoppedBy` and `stoppedAt` with scope
`local-dispatch-stop` and false provider-contact, cancellation-confirmation,
execution and settlement authority flags. Existing claims, settlements or
unattributed legacy markers return 409 without asserting a new stop.
A storage/readback failure returns 503 even if the stop committed; an explicit
retry may recover that same immutable stop. There is no automatic retry,
provider transport, budget release, schema initialization or public MCP mutation.

`GET /api/control/{tenant}/dispatch-stops/{intentId}` reads the same owner-scoped
stored facts without recording a stop or retrying a command. It accepts no query
options and returns `not-stopped`, `stopped`, `already-claimed`, `already-settled`
or `legacy-stop`. A claim takes precedence over a historical stop. Only `stopped`
includes the originally recorded actor/time; legacy attribution is never invented.
Missing and out-of-scope intents have the same denial. The result is uncached,
requires current ownership in the evidence SELECT and cannot authorize a later
write or handoff. All provider-contact, cancellation, execution and settlement
authority flags remain false. A stop committed before a lost POST acknowledgement
can therefore be inspected using only this GET. No audience is required, and the
initialized 0032 schema supports this read; unsupported storage fails closed
without initialization or migration.

## Cancellation after a dispatch claim

An active tenant owner can call the internal `requestJobCancellation(access, intentId)`.
It takes no caller-supplied job reference. The Gateway verifies the stored
binding, pending receipt and deterministic job identity; migration 0012 checks
the owner, bounded claim and job ID again at insert. The first request records
the owner and database time. Concurrent owners and retries cannot replace it.
Use `readJobCancellation(access, intentId)` to inspect without requesting.

| State | Meaning |
|---|---|
| `not-requested` | A bounded claim exists with no local request or known terminal result. Read-only result. |
| `requested` | An owner asked to cancel the bound job. No warehouse outcome is known. |
| `terminal` | A stored, matched observation reports `succeeded`, `failed` or `cancelled`. The original request is returned if one exists; none is added after the fact. |
| `settled-unverified` | A historical settlement exists without a matched terminal observation. It blocks a new request but does not establish the warehouse outcome. |

Both helpers return the bound job reference and recheck current owner access.
Neither sends a cancellation, dispatches a job, releases a reservation, settles
costs or rewrites a receipt. Even a later `cancelled` observation does not
establish that this local request caused it. There is no public endpoint.

### Explicit cancellation transport (offline)

`sendRequestedJobCancellation(access, intentId, transport)` is a separate internal
boundary for a recorded request on a bounded, non-delegated job. The caller must
inject both a trusted token loader and a sender; no default credential lookup,
network sender or public route is installed. This legacy wrapper still refuses
delegated bindings; the separate delegated boundary below requires attributed
requests. Neither boundary is production cancellation wiring.

The boundary pins the tenant/principal and reads the stored job identity and
current owner authority before preparing a token. It repeats that read after
token preparation, refusing changed identity, revoked authority, conflicts or
missing state. No request, a matched terminal observation or a historical
settlement returns `not-sent`. A fifteen-second deadline covers token preparation,
the final read and sending; late pre-send continuations cannot send. The final
read is a local decision point, not an atomic revocation of an external request.

Only a still-requested job permits one sender call per invocation: an empty-body
POST to the fixed BigQuery host, stored project/job and location, with redirects
disabled. The conservative routing profile rejects unsafe identifiers before
loading credentials. Tokens and provider diagnostics are not returned or stored.
After handoff, every HTTP status, thrown sender or timeout returns
`observation-required`; response bodies are discarded, including late responses.
There are no retries, job submissions, accounting writes or terminal receipts.

This follows the [BigQuery cancellation contract](https://docs.cloud.google.com/bigquery/docs/reference/rest/v2/jobs/cancel):
a cancel request returns before the final outcome and a cancelled job may incur
cost. Observe the same bound job and obtain authoritative billing separately.
The existing durable request records owner intent, not a send attempt or remote
acceptance. Another explicit invocation can send again: no durable attempt log,
cross-invocation exactly-once guarantee or operational recovery policy is claimed.
Tests use synthetic credentials, intercepted sends, SQLite and local native D1.

### Delegated cancellation (offline)

With migration 0034, `requestDelegatedCancellation(owner, audience, intentId)`
records the current tenant owner, database time, stored job, audience and original
compiled-body digest. `readDelegatedCancellation` inspects without requesting.
Both use the verified claim/pending-receipt recovery view. The conditional insert
and database guard recheck owner authority and exact attribution; concurrent
requests and replacement attempts preserve the first record. A later delegation
expiry or withdrawal does not prevent a current owner from recovering or
cancelling an already claimed job. It never permits another execution.

`sendRequestedDelegatedJobCancellation(owner, audience, intentId, transport)`
uses the same bounded sender above, rechecking both stored job identity and
claim attribution after token preparation. Other tenants/audiences, non-owners,
unclaimed jobs, initial storage failures and unsupported schemas never reach
credentials or a sender. A failed final read also prevents sending. Known terminal
outcomes suppress sending and retain the reservation
until separate authoritative billing reconciliation.

Historical request rows keep NULL attribution after upgrade and return
`unverified-request`; they cannot trigger a send or be silently replaced by a
new owner request. Missing provenance needs separately audited reconciliation,
not invented backfill. These helpers neither produce an authenticated export
of cancellation provenance nor a durable send-attempt log. Existing observation,
billing and export boundaries retain their own requirements.

Migration 0034 is an offline-tested installation requirement, not authorization
to migrate an existing production database. These internal transports do not
enable provider credentials, a production migration or a default network sender.

### Authenticated cancellation request recording

`POST /api/control/{tenant}/cancellation-requests` accepts exactly
`{"intentId":"..."}`. Prepend the configured mount path when deployed under one.
The route requires an exact same-origin JSON request, a signed session and current
tenant ownership. The server supplies the audience; query options and caller-supplied
identity, job, sending or billing options are rejected. The request body is bounded
to 2 KiB with the shared timeout and abort handling.

The route invokes only `requestDelegatedCancellation`. A 200 response acknowledges
the stored first requester/time, including on retries by a replacement owner.
The response has `scope: recorded-request-only` and false provider-contact,
cancellation-confirmation, cancellation/execution/settlement authority flags.
It does not send a cancellation, read provider status, release a hold or make a bill.
A prior terminal observation without a request, or an unattributed legacy request,
returns 409. An existing attributed request remains readable after a terminal
observation; acknowledging it does not establish that it caused that outcome.

Invalid sessions receive 401 and inaccessible claims/tenant membership are denied.
Storage failures return a sanitized 503. Failure can occur after a request is stored;
retrying recovers the same first record, never a new cancellation send. Responses
are private and not cached. Schema 0034 is still required, never installed by this
route. The local MCP tools remain read-only; no public mutation tool or provider
wiring is implied. [Request evidence](CANCELLATION_EVIDENCE.md) is a separate read.

The owner can record this intent from the job recovery page after inspecting the
bound job and explicitly checking the confirmation. The browser rereads the job
before one POST, then verifies separate request evidence against the acknowledgement
and reviewed job. A terminal observation or changed job prevents that POST.
An uncertain response is never automatically repeated: the separate recovery
control only reads recorded evidence. Scope edits, rereads, hiding and navigation
discard the prior confirmation and result. Stored requester/time remain historical,
not necessarily the current owner. No result claims provider cancellation or billing.

Coverage uses actual migration and service SQL in SQLite and a test adapter.
This is not a live submission path or independent authentication of a remote
agent. The [offline-tested jobs.insert boundary](BIGQUERY_GOVERNED_TRANSPORT.md)
still needs an authoritative definition store, verified delegation, warehouse
permissions and billing configuration, authenticated network wiring, and
operational cancellation and recovery before use with a real tenant.
Legacy schema import and dry-run endpoints are outside this governed handoff.
