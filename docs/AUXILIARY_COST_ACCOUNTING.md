# Model and Tool Cost Accounting

Migration 0033 adds internal accounting for model/tool costs outside the SQL scan
allowance. It follows migrations 0001-0032 and has only been exercised against
local synthetic databases. Do not apply it to an existing production database
without separate migration authorization. No public endpoint or provider dispatch
is enabled by this delivery.

`reserveAuxiliaryCost` binds an immutable component ID, operation reference,
operation digest, kind (`model` or `tool`) and positive safe-integer micro-USD
ceiling to an existing tenant execution intent. Its budget is derived from that
intent, never selected by a caller. SQL and auxiliary reservations compete for
the same remaining capacity under the database write lock. Active local owner
membership is checked at the write, not inferred from provider metadata.

The trusted internal caller must authenticate the actor, obtain a conservative
cost ceiling from applicable pricing, retain the operation evidence, and reserve
before any separately authorized provider handoff. This module neither verifies
pricing nor gives a `data.read` contract permission to execute a model or tool.
Historical intent eligibility is not current execution authority. It cannot
capture costs incurred before an intent or charges for operations never reserved.

`settleAuxiliaryCost` accepts only final, per-operation billing evidence with
`status: "final"`, `unit: "micro-USD"`, the exact `operationRef`, a distinct
opaque `reference`, and nonnegative safe-integer `actualMicroUsd`. A trusted
reconciler must verify the bill's authenticity and attribution outside this
primitive. References are locators, not signatures or proof that a provider was
queried. Do not put credentials, prompts or business data in references.

Unknown, partial, timeout or cancellation evidence does not settle anything.
The original hold remains durable until a final bill arrives; zero must be an
explicit authoritative final amount. Caller revocation does not prove zero cost:
a currently authorized tenant owner can still record a late bill.

Each settlement releases only its own hold. It records the full actual cost,
adds the portion fitting the remaining budget to `spent_units`, and records the
rest in `overrun_units`. Overrun blocks new SQL and auxiliary admissions, but
does not prevent other outstanding settlements. Existing ledger semantics are
preserved: the spent/overrun split depends on the reservations still outstanding
at settlement time, and is not automatically rebalanced when later holds clear.
Counter overflow fails closed, retaining the original hold for operator review.

Matching retries return `replay: true`, including after a lost acknowledgement;
they never create a second hold or bill. Changed bindings conflict. Concurrent
first attempts may return one duplicate error; retrying recovers the committed
record. Operation references and final billing references are unique per tenant.
One aggregate provider invoice must not be reused as if it were several
independently attributed component bills.

Reservations, final settlements and their audit events are append-only. Replacing,
updating or deleting a component is rejected. Capacity updates and the audit event
commit in the same transaction as the component; missing or failed audit writes
roll back accounting. `readAuxiliaryCost` is a current-owner-scoped recovery read,
not permission to submit another job or a claim that a pending operation failed.

The [auxiliary component export and detached verifier](AUXILIARY_COST_EVIDENCE.md)
cover recorded holds/bills and their audit links, with unknown costs explicit.
The existing BigQuery settled-evidence profile and coverage inventory remain
SQL-job-specific. Neither profile establishes total workflow cost. Provider
adapters, authoritative billing capture, partial-bill accumulation, complete
cross-provider inventory and independent acceptance remain separate work.
No benchmark or protocol object schema was changed.

Tests: `tests/auxiliary-costs.test.ts` and
`tests/auxiliary-costs-miniflare.test.ts`, sharing accounting cases against SQLite
and installed native D1. The native fixture applies the actual migration
statements using SQLite's statement parser rather than splitting trigger bodies
on semicolons. Tests use synthetic identities and bills, never remote queries.
