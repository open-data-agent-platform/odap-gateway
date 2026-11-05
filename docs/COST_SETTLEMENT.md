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

This is not a production billing or execution endpoint. Trusted billing input,
agent/policy/release rechecks, job identity verification, pending receipt/outbox,
period rollover, adjustment handling and D1 integration remain required. Existing
member roles do not authenticate warehouse job evidence. Public mutation APIs
remain absent. SQLite constraints are tested locally; migration tests remain
manual until workflow permissions permit adding them to CI.
