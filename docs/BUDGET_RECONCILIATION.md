# Combined Budget Reconciliation Read

`readBudgetReconciliation(access, budgetId)` is an internal, read-only inspection
of persisted SQL, model and tool accounting for one tenant budget. The caller
must supply an authenticated `ControlAccess`, not a principal ID from a request
body. The database statement checks current active `owner` membership in that
same tenant. A missing budget or ineligible principal returns `null`.

All counters, SQL intents, auxiliary components, settlements and audit checks are
read in one statement. There is no earlier membership result to cache, no second
read that can observe a different settlement state, and no provider access or
database write. Requester revocation does not erase liabilities; a still-current
owner may inspect them. The result contains budget/tenant scope and counts/totals,
not prompts, billing references or actor identities.

The response separates `sql`, `model` and `tool` buckets. Each reports recorded,
settled and pending component counts, recorded actual cost, and pending reserved
capacity. No bill is different from a final zero bill. All amounts are decimal
micro-USD strings computed using exact integer arithmetic. Individual stored
amounts must be nonnegative safe integers; totals can exceed that range.

`countersConsistent` checks that all pending SQL and auxiliary holds equal the
budget's reserved counter, that all recorded final liabilities equal spent plus
overrun, and that spent plus reserved does not exceed the budget limit. The
historical spent/overrun split is retained rather than redistributed. Signed
`difference` values are recomputed amounts minus recorded counters, not repair
instructions. A zero reservation without a bill still counts as pending.

`attributionConsistent` is separate. Invalid terminal SQL receipt linkage,
missing/duplicate/mismatched auxiliary audits, reversed auxiliary audit order or
a component bill bound to another operation makes it false. Unassignable records
anywhere in the selected tenant also block attribution consistency because their
budget cannot be inferred safely. Other tenants do not affect the result. These
flags do not replace full [SQL evidence verification](SETTLED_EVIDENCE.md),
[auxiliary evidence verification](AUXILIARY_COST_EVIDENCE.md), or provider bill
authentication. `consistent` is true only when both local checks pass.

The reader accepts at most 1,024 SQL intents and 1,024 auxiliary components per
budget, and bounds each serialized inventory to 4 MiB. Oversized inventories or
malformed/duplicate storage identities throw rather than returning truncated
totals. A database read failure produces a generic `Budget accounting unavailable`
error without propagating raw storage diagnostics. Missing migration 0033 is not
an empty auxiliary ledger and cannot produce a successful reconciliation.

Every result discloses `scope: "recorded-budget-accounting-only"`,
`completeWorkflowCost: false`, `issuerAuthenticated: false` and
`executionAuthorized: false`. Balanced recorded costs do not prove there were no
unrecorded operations, that records are current/authentic, or that any pending
operation may be retried. An empty inventory is not a total-cost certificate.

There is no HTTP/MCP route, UI integration, provider dispatch or production
migration in this delivery. Production installations at migration 0032 remain
unchanged. Future exposure requires schema compatibility handling and the shared
authentication/policy path; do not enable demo mode or bypass migration approval.
The [offline restore checker](COST_RESTORE.md) remains a separate operator tool
for comparing two detached snapshots, not a live authorization mechanism.

Tests use disposable synthetic SQLite and native D1 databases with the same
accounting cases. No real model, tool, warehouse or production database is used.
