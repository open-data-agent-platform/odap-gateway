# BigQuery job recovery (development)

The preview client sends `configuration.dryRun: true` on jobs.insert. An
explicit zero-byte estimate is valid; a missing, malformed or unsafe integer
estimate blocks the preview. Estimates are not final billed bytes.

The internal recovery reader in `lib/bigquery-job-recovery.ts` only looks up
jobs. A future dispatcher must pin project and location with the admitted
intent before submission, use its deterministic job ID and action label on
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
dispatch, receipt issuance or budget settlement is wired to it yet.

References: [BigQuery Job](https://cloud.google.com/bigquery/docs/reference/rest/v2/Job)
and [jobs.get](https://cloud.google.com/bigquery/docs/reference/rest/v2/jobs/get).
