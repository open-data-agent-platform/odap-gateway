# Missing-release denial before approval

`recordMissingReleaseDenial` is an internal negative decision for a structured
metric read. It can issue a receipt only if the requested semantic release
does not exist in the authenticated tenant. A release in another tenant does
not count. An existing but retired or ineligible release is a different case.
No public endpoint is added; an error or missing receipt is never permission
to proceed.

The service must supply authenticated tenant/principal access, a verified
agent identity and an opaque, server-assigned attempt ID. Do not accept those
identities from a request body. Migration 0010 checks active membership and
release absence under the same write lock. It stores the attempted release
identifier and the digest of the structured action, not its parameter values,
SQL or query results.

The denial record, existing-format Evidence Receipt and receipt-created audit
event commit together. The event actor is the authenticated principal.
`intentId` on this receipt is the attempt correlation key, **not** an admitted
execution intent. `contractId` and `semanticReleaseId` are explicitly null;
the receipt states why. No approval, budget reservation, job or charge is
created. The general tenant-scoped receipt read policy is unchanged.

| Case | Result |
|---|---|
| Exact retry by the same active member, including after the release is published | Original receipt and timestamp; no new audit event. |
| Same tenant and attempt, different principal, agent, requested release or action | Conflict; original decision is unchanged. |
| Fresh attempt against a release that exists, or an already admitted attempt | No missing-release receipt. |
| Later admission under a denied attempt ID | Rejected. A genuinely new attempt needs a new ID and independent authorization. |
| Pre-migration receipt with a colliding ID | Neither overwritten nor adopted; no historical denials are backfilled. |

The settled BigQuery exporter intentionally excludes this class of receipt:
there is no terminal job or bill to verify. Offline coverage is in
`tests/preapproval-denial.test.ts`. This is one refusal case, not evidence
that every Gateway decision is captured.
