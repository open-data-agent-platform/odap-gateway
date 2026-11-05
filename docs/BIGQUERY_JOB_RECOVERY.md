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

## Terminal observations without a bill

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
