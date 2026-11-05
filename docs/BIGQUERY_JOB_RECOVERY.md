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
Live authorization rechecks, dispatch, final receipt issuance from trusted
outcomes, and tests on a deployed tenant are not part of this change.

References: [BigQuery Job](https://cloud.google.com/bigquery/docs/reference/rest/v2/Job)
and [jobs.get](https://cloud.google.com/bigquery/docs/reference/rest/v2/jobs/get).
