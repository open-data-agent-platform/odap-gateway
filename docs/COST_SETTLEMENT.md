# Cost Settlement Foundation

Apply migration 0004 after 0003, once only. No remote rollout is included.
The internal reconciler accepts a validated final receipt and authoritative
actual cost in integer micro-USD. Receipt insertion, settlement and counter
updates use a D1 transactional batch. Settlement checks active owner membership
and receipt/intent/contract/release linkage. One intent has one settlement.

Unknown cost returns pending without releasing its reservation or creating a
final receipt. The caller must retain job/outbox evidence for later reconciliation.
Exact retries return existing settlement; changed cost or evidence conflicts.
Concurrent duplicate attempts may conflict and can be retried. Corrections and
late additional charges require a future append-only adjustment mechanism.

Actual cost can exceed the reservation or remaining budget. The original bounded
spent counter records the portion within remaining ledger capacity; overrun_units
records the excess liability. Their sum is accounted actual spend. The immutable
settlement stores full actual cost. Any overrun blocks new admissions, even zero
cost attempts, until an explicitly audited resolution mechanism is implemented.
Do not report spent_units alone as total spend. Unknown costs remain reserved.

## Bounded BigQuery jobs (local engineering)

Migration 0009 adds a separate, immutable billing evidence record. The
internal `reconcileBigQueryBill` function reloads the prepared job and pending
receipt and requires a [durable terminal observation](BIGQUERY_JOB_RECOVERY.md#terminal-observations-without-a-bill).
Only then does it ask a trusted, explicitly injected source for a final charge.
There is no default source, network client or public mutation endpoint.

| Evidence available | Result |
|---|---|
| No terminal observation | No billing lookup or new settlement. |
| Terminal observation, no final bill | Keep the reservation. A missing bill on replay does not erase an existing verified settlement. |
| Final per-job total | Require the exact tenant, project, location and job ID, a stable tenant-unique evidence reference and a nonnegative safe integer in micro-USD. Explicit zero is valid, including for failed or cancelled jobs. |
| Different bill reference or amount on replay | Reject the conflict. No new receipt, debit or silent correction. |

Under one SQLite write lock the service rechecks owner membership, records the
opaque evidence reference, issues a final receipt from the stored outcome and
applies the existing ledger rules. All effects roll back together. The original
pending receipt is unchanged. Exact concurrent retries return the same final
receipt, including its timestamp. Existing settlements without provenance are
not backfilled or adopted; they require independent review.

The source must establish authenticity, finality and job-level monetary
attribution **before** returning a charge. A meter reading, per-byte estimate,
partial invoice line or a caller-supplied amount is not a final bill. This
checkpoint uses synthetic sources and temporary SQLite databases only. Live
billing attribution, adjustments, period rollover and deployed integration
remain outside its scope. The receipt wire schema is unchanged.

For read-only inspection after settlement, see [settled evidence export](SETTLED_EVIDENCE.md).
