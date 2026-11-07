# Budget and Execution Intent Admission

Apply migration 0003 after 0001 and 0002. No remote changes are included.
This is an internal admission primitive, not a public execution endpoint.

Budgets use nonnegative safe integer micro-USD units. Capacity is checked against
spent plus reserved units. A server-side estimator must supply a conservative
upper bound; an untrusted client estimate is not acceptable. Billing-mode and
model/tool costs require separate coverage. Estimates alone cannot guarantee bills.
The optional [auxiliary accounting primitive](AUXILIARY_COST_ACCOUNTING.md) adds
separate model/tool holds and final bills in migration 0033. It is not wired to
production execution, does not authorize provider calls, and does not extend
the SQL-only evidence profile to total workflow cost.

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

## Delegated admission

With migration 0022 the original requester can POST exactly
`{"contractId":"..."}` to `/api/control/{tenant}/budget-admissions` using a
signed session and same-origin JSON. The requester cannot set the intent ID,
budget, amount, reservation, or pricing. There is no automatic budget routing:
the operator must bind (tenant, target, policy revision) to an existing budget
and a positive **per-read allowance in micro-USD**. That binding is immutable.

The allowance is a policy maximum for an on-demand scan, not an estimate of
the actual charge or a limit on other tools. The matching scan policy must
still be valid for the approved project and location, and the allowance must
buy at least one byte. A future job must use the [byte ceiling](../lib/bigquery-byte-ceiling.ts)
derived from the reserved allowance, the scan rate and the operator byte limit.

Under the write lock the database checks live delegation, proof, contract
state, policy and capacity. It reserves the full allowance, consumes the
contract, appends the lifecycle event and creates one immutable intent in the
same transaction. The first admission returns 201 with `admission.contractId`
and `admission.intentId`. Retry returns 200 with the same IDs while the
requester and delegation remain eligible, even if this reservation used the
last available funds. A 409 means this request cannot obtain an admission
acknowledgement; a 503 does not prove the transaction failed.

**Admission is not dispatch.** Migration 0022 alone does not permit job
preparation. With 0023, a tenant owner can separately [prepare a delegated
job identity](BIGQUERY_JOB_RECOVERY.md#delegated-preparation); submission
is still blocked. Later revocation is not evidence of zero cost and does not
refund a reservation. These local tests demonstrate no bill or settlement.

### Review a requester reservation

From **My contract request**, look up the proven delegation and its issued
contract. **Review budget reservation** reads
`GET /api/control/{tenant}/budget-quote/{contractId}`. It does not consume
the contract or hold capacity. Only its original requester, in the configured
audience and with an eligible contract, can see the budget and the exact
policy allowance. No visible quote (404) is not proof of a prior admission
or rejection. Missing storage or configuration is not an empty quote.

**Cancel** discards the quote. **Confirm reservation** posts only the contract
ID to the existing admission endpoint. The budget and micro-USD amount come
from the immutable policy; capacity and authority are checked again at the
write. If the acknowledgement is lost, the UI does not retry the command
or assume funds are free. A 200 replay acknowledges the earlier intent,
not a second hold. No part of this flow prepares or submits a job.

### Recover the original reservation

After looking up the issued contract, use **Look up reservation**, including
after an ambiguous POST. This sends only
`GET /api/control/{tenant}/contract-admission/{contractId}`. The ID and
amount come from the immutable admitted intent, not today's quote or the
budget counter. A successful read confirms the historical reservation,
not a current hold, a final charge, a refund or permission to dispatch.
Reading it neither repeats admission nor queries the warehouse.

The original requester must still be an active member of the tenant, and
the issuance and admission must match the configured audience. Exhausted
capacity, expiry, delegation revocation and settlement do not erase the
record. A missing or invisible admission returns 404 without identifying
another requester; unavailable storage/configuration returns 503. Neither
response proves an earlier command failed. Refreshes clear the old result
on loss of access.

### Locate the intent's receipt

From the recovered reservation, **Look up receipt** sends a single
`GET /api/control/{tenant}/intent-receipt/{intentId}`. It reads only
Gateway storage (migrations through 0026); it never polls BigQuery,
starts a job, retries admission or changes a budget.

| Visible result | Meaning |
|---|---|
| No receipt linked | The original admission is visible, but no job binding has attached a receipt. |
| Pending receipt | Job preparation created a receipt. This does not establish dispatch or a final outcome, even when the warehouse has reported completion. |
| Final receipt | The succeeded, failed or cancelled outcome is linked to the claim, terminal observation, attributed bill and settlement. No charge amount is disclosed. |

This lookup requires active tenant membership, the original requester and
the configured audience, not an unexpired grant. A missing or invisible
intent returns 404; missing storage or unverifiable provenance returns 503.
Neither is evidence that the job failed. The summary contains no SQL,
free-text reason, principal or billing reference.
