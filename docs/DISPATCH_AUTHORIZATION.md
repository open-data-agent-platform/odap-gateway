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
   admitted but unclaimed intent via `dispatch_stopped_intents`. Stopping an
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
The claim is the local decision time, **not** proof of warehouse acceptance.
A revocation committed before the claim prevents handoff. A revocation after
the claim cannot atomically retract an external request. Crash or timeout
after claiming is ambiguous: **observe the same job, do not resubmit**. Even
a 404 does not rearm a claim. Cancellation, abandoned-reservation resolution
and terminal/denial receipts need separate handling.

Coverage uses actual migration and service SQL in SQLite and a test adapter.
This is not a live submission path or independent authentication of a remote
agent. A production adapter still needs an authoritative definition store,
warehouse-level permissions, verified billing configuration, a transport that
preserves the ceiling, cancellation and recovery.
Legacy schema import and dry-run endpoints are outside this governed handoff.
