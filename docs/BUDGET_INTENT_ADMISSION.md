# Budget and Execution Intent Admission

Apply migration 0003 after 0001 and 0002. No remote changes are included.
This is an internal admission primitive, not a public execution endpoint.

Budgets use nonnegative safe integer micro-USD units. Capacity is checked against
spent plus reserved units. A server-side estimator must supply a conservative
upper bound; an untrusted client estimate is not acceptable. Billing-mode and
model/tool costs require separate coverage. Estimates alone cannot guarantee bills.

One INSERT transaction creates an immutable execution intent, reserves capacity,
consumes the contract and records the lifecycle event. Any constraint failure
rolls back the whole operation. Tenant references, active membership, original
principal, action digest, reservation ID and expiry are checked. Existing matching
intent IDs return replay=true without new consumption; changed payloads conflict.
Two simultaneous first attempts with the same ID may return one duplicate error;
retrying retrieves the winning intent. Replay is not permission to submit a new job.

The internal caller still must verify agent identity, policy revision, semantic
release eligibility and target. Those checks are not yet atomic with admission.
No real warehouse job may be launched from this primitive alone. Job IDs,
outbox/dispatch, effective release revocation and durable result receipts are
subsequent work. Existing standalone consumeContract remains a lower-level
primitive and must not precede admission, which performs consumption itself.

Reservations remain held across uncertain outcomes. No automatic release,
settlement, budget-period rollover or cancellation recovery exists yet. Do not
use this unfinished ledger for production billing enforcement. A subsequent
reconciliation service must handle actual cost exceeding estimates explicitly.

Tests: Vitest plus `python tests/budget-intents-migration.py`; real SQLite tests
cover parallel capacity admission, duplicate IDs, membership withdrawal and
rollback of both budget and contract consumption. D1 integration remains needed.
