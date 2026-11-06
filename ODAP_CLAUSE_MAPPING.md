# ODAP Clause Mapping - Reference Implementation Status

Maps every clause of the [ODAP Scoring Rubric v1.0](https://github.com/open-data-agent-platform/awesome-odap/blob/main/RUBRIC.md)
to its implementation in this codebase. Statuses are deliberately conservative:
**Implemented** (working and covered by local tests), **Partial** (exists with
limits), and **Planned** (roadmap, not yet built).

Last reviewed: July 2026 against local v0.1.0 package.

## MUST 1 - OPEN

| Clause | Status | Where / Notes |
|---|---|---|
| O1.1 Open table formats | **Planned** | BigQuery-native today; Iceberg/Delta reads targeted post-v0.2 (see ROADMAP). |
| O1.2 Heterogeneous sources | **Planned** | Single-source (BigQuery) by design: starting with BigQuery, done deeply. |
| O1.3 Exit cost | **Partial** | Schema policies, query runs, and audit events live in D1 (`db/schema.sql`) and can be exported from D1; no one-click export UI yet. |
| O1.4 Protocol openness | **Partial** | REST endpoints via Cloudflare Functions (`functions/api/*`); documented locally but not yet a stable public API spec. |

## MUST 2 - SEMANTIC

| Clause | Status | Where / Notes |
|---|---|---|
| S2.1 Metric definition | **Partial** | Schema field semantics via `lib/schema-policy.ts` and `lib/schema-import.ts`; business-editable metric layer not yet built. |
| S2.2 Consistent resolution | **Partial** | Single schema/policy source inside the platform; no cross-tool metric sharing yet. |
| S2.3 Context awareness | **Partial** | Time-window and dimension patterns in `lib/copilot-engine.ts`; assumptions are surfaced as notes, but not a full semantic resolver. |
| S2.4 Nested model support | **Partial** | BigQuery SQL safety logic recognizes STRUCT/ARRAY patterns (`lib/schema-policy.ts`), but full nested semantic modeling is not implemented. |

## MUST 3 - GOVERNED

| Clause | Status | Where / Notes |
|---|---|---|
| G3.1 Pre-generation permissions | **Partial** | OAuth/admin gating exists (`lib/auth.ts`, `functions/_middleware.ts`), but query generation is not fully permission-pruned before draft creation. |
| G3.2 Approval routing | **Implemented** | Run-review workflow in `functions/api/admin/run-reviews/[id].ts`, `components/approvals-page.tsx`, and threshold-based review queue logic. |
| G3.3 Pipeline separation | **Implemented** | Generate, dry-run validate, and review are separate stages (`lib/copilot-engine.ts`, `functions/api/query/dry-run.ts`, `lib/admin-store.ts`). |
| G3.4 Sandbox validation | **Planned** | Dry-run covers cost/syntax; masked-data sandbox execution is targeted for v0.2. |

## MUST 4 - AUDITABLE

| Clause | Status | Where / Notes |
|---|---|---|
| A4.1 Generation trail | **Partial** | `audit_events` and `query_runs` tables (`db/schema.sql`) record SQL, actor, dry-run metadata, and policy checks; original natural-language prompt capture is not complete. |
| A4.2 Decision trail | **Implemented** | Approvals, rejections, schema changes and user changes are logged in `lib/admin-store.ts` and admin functions. Deployment rollback is unsupported; historical `rollback.queued` entries do not prove execution. |
| A4.3 Explainability | **Partial** | Generated SQL and dry-run stats are shown; confidence scoring and full validation evidence per answer are not complete. |
| A4.4 Replayability | **Partial** | Historical runs are reconstructable from D1 records; no one-click replay UI yet. |

## MUST 5 - COST-CONTROLLED

| Clause | Status | Where / Notes |
|---|---|---|
| C5.1 Pre-execution estimation | **Implemented** | BigQuery dry-run returns bytes, estimated cost, and runtime before execution (`lib/bigquery.ts`, `functions/api/query/dry-run.ts`). |
| C5.2 Budget enforcement | **Partial** | High-cost or risky queries can be held for approval; hard organization-level circuit-breaker is planned. |
| C5.3 Attribution granularity | **Partial** | Per-query records exist in `query_runs`; user attribution is present when a session is available, but anonymous dry-runs are still allowed. |
| C5.4 Optimization loop | **Planned** | Rewrite suggestions with savings estimates targeted for v0.2+. |
| C5.5 Energy awareness (v1.1 proposed) | **Planned** | Tracking rubric proposal #2 in awesome-odap. |

## Summary

**Implemented 4 | Partial 12 | Planned 5** (20 v1.0 clauses plus C5.5 proposed).
Several statuses were intentionally downgraded from the initial draft during
local path and behavior verification. The package favors credibility over
green checkmarks.

Disagree with any status? File an issue citing the clause ID and public evidence.
