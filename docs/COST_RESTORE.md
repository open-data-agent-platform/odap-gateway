# Offline Cost Restore Comparison

`scripts/check-restore-costs.py` compares recorded SQL/model/tool accounting in
two distinct, detached SQLite snapshots for one exact tenant. It is a local
operator diagnostic, not an execution, serving or migration gate. It requires
the accounting tables through migration 0033 in both inputs. An older schema is
an unsupported input, not evidence of zero auxiliary cost. Do not migrate an
existing production database just to run this check.

```sh
python -B scripts/check-restore-costs.py --restored restored.sqlite --reference retained-later.sqlite --tenant tenant-id
```

Use standalone, offline rollback-journal-mode copies. The existing snapshot
reader rejects a repeated file (including a hard link), missing files, WAL-mode
headers and journal/WAL/SHM sidecars. It opens with `mode=ro&immutable=1`, enables
`query_only`, and disables trusted schema functions. Never use it on a live
database or a file another process can modify. No credentials, remote databases,
warehouse jobs, model/tool calls or repair writes are used.

For each budget, the checker independently recomputes these two invariants:

- `reserved_units` equals the SQL intent holds with no SQL settlement plus the
  model/tool component holds with no component settlement.
- `spent_units + overrun_units` equals all recorded SQL and auxiliary final
  settlement amounts attributed to that budget.

The spent/overrun split is historical and is not redistributed when later holds
clear. An unexplained opening balance or out-of-band counter update is reported
as an inconsistent budget; the tool does not manufacture a balancing adjustment.
Unknown costs remain pending even when a SQL reservation is zero. Explicit final
zero bills are distinct from no bill. Python integers preserve exact sums, which
the JSON report emits as decimal micro-USD strings.

The comparison includes immutable intent, reservation and settlement columns,
budget counters, and auxiliary audit records, not only aggregate totals. It
checks same-tenant budget/intent/component links, SQL settlement receipt linkage,
unique attribution references, and exactly one matching auxiliary audit event
per recorded transition. A settled component's reservation audit must precede
its settlement audit. SQL receipt contents and the full audit stream require the
existing [settled evidence verification](SETTLED_EVIDENCE.md) and restore checks;
this is not a replacement for those verifiers.

Output contains counts and totals, never tenant/actor IDs, operation references,
receipt bodies or input paths. Inputs exceeding 10,000 rows in any selected
inventory are rejected, not truncated. Monetary counters must be nonnegative
safe integers individually. Malformed or incomplete bindings give a generic
diagnostic without a partial success report.

Exit codes:

- `0`: selected accounting rows match and both snapshots' counters reconcile.
- `1`: records differ, or at least one budget's counters do not reconcile.
- `2`: invalid CLI arguments, unsupported snapshots/schema/scope, oversized
  inventory or unusable attribution/audit bindings; no comparison was made.

Two individually consistent snapshots may differ because a hold or late bill was
recorded between them. Two identical snapshots can both contain the same counter
error and still exit 1. Inspect and retain these differences before choosing a
recovery point; do not automatically release holds, reapply bills or retry jobs.

Every report fixes `scope` to `recorded-tenant-accounting-only` and sets
`issuerAuthenticated`, `completeWorkflowCost`, `retryAuthorized` and
`servingAuthorized` to false. Matching files cannot prove provider authenticity,
freshness, absence of omitted operations, or total workflow cost. An empty
inventory is not proof of no incurred costs. Current authority, SQL dispatch
history, retained evidence pins and external bills remain separate recovery
requirements. No independent review or production recovery is claimed.

Regression coverage: `tests/restore-cost-accounting.test.ts` creates actual
migrated synthetic SQLite databases, takes point-in-time copies across pending,
SQL-settled and auxiliary-settled phases, and verifies unchanged snapshot bytes
and exported auxiliary evidence after restoration. Adversarial copies exercise
lost rows, changed attribution, counter drift, audit damage and input boundaries.
