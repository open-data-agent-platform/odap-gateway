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
consumed contract, or rewrite a pending receipt. No public stop API is wired.

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

Coverage uses actual migration and service SQL in SQLite and a test adapter.
This is not a live submission path or independent authentication of a remote
agent. The [offline-tested jobs.insert boundary](BIGQUERY_GOVERNED_TRANSPORT.md)
still needs an authoritative definition store, verified delegation, warehouse
permissions and billing configuration, authenticated network wiring, and
operational cancellation and recovery before use with a real tenant.
Legacy schema import and dry-run endpoints are outside this governed handoff.
