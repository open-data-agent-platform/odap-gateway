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

## Delegated job settlement

Migration 0026 and [the delegated reconciler](../lib/delegated-billing.ts)
extend the same ledger to a job claimed for a specific delegation audience.
Only a current tenant owner can invoke this internal service. It verifies the
original claim and requires a terminal observation tied to its compiled-body
digest before it discloses a job reference to the injected billing source.
Expiry or withdrawal after handoff does not erase an incurred liability.

- No verified terminal observation: `pending-terminal`, no source call.
- No bill (`null`), or an exactly attributed `pending`, `provisional` or
  `estimated` record: `pending-bill` unless a verified settlement already
  exists. The provisional amount is never used.
- A `final` total: exact tenant, project, location and job ID, a stable
  evidence reference, unit `micro-USD`, and a nonnegative safe integer amount.
  Zero is valid only when explicit. A failed or cancelled job can cost money.

The write rechecks the owner, audience, claim, attribution and terminal
evidence. Billing evidence, the separate final receipt and its audit event,
budget reservation release, actual spend and excess liability commit together.
Concurrent exact repeats return the same receipt; a different amount or
reference conflicts. A source error or a lost acknowledgement is not proof of
zero cost. Use `readDelegatedBilling` for local inspection without calling a
billing source. Unattributed pre-upgrade settlements are retained but this
service refuses to certify or settle them again.

The source is an explicit local test dependency, not a billing provider
integration. The generic export and coverage formats do not by themselves
attest delegated billing provenance. No receipt schema or standard changes.
