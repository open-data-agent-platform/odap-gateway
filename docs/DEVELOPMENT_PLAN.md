# ODAP Gateway Development Plan

Date: 2026-11-05. Status: proposed execution plan, not a release commitment.
Revision: 2 - object-centered governance and evidence-based progression gates.
Repository: https://github.com/open-data-agent-platform/odap-gateway

## 1. Decision

Build an open control plane for enterprise agent data actions, organized around
three first-class objects: Semantic Release, Approval Contract, and Evidence
Receipt. Start with a governed read-only BigQuery workflow. SQL generation,
BigQuery, and MCP are implementation surfaces supporting those objects.
Add a second engine only after the execution contract is proven.

The long-term hypothesis is governance of enterprise agent actions. Expansion
beyond data reads requires separate action-specific threat models, controls,
and pilot evidence; write access and general automation are outside this cycle.

The initial customer hypothesis is a data platform team operating multiple
agents or tools over BigQuery, with a named data owner and an operational need
to approve definitions or constrain execution. Validate this hypothesis through
interviews and pilots before treating it as established demand.

The primary pilot question is whether a team will entrust ODAP with execution
authorization and evidence for real agent workloads. A successful chatbot demo
does not answer that question. No valuation follows from this positioning.

## 2. Evidence and method

This plan combines repository inspection, GitHub status checks, and official
product documentation reviewed on the date above. It includes no hands-on
competitive benchmark, market-size estimate, price comparison, or revised ODAP
vendor score. Feature availability depends on edition, region, and configuration.
Product observations below are facts from sources; positioning and priorities
are recommendations inferred from those observations.

## 3. Competitive landscape

| Product / category | Documented capability | Competitive implication | Gateway response |
|---|---|---|---|
| Wren AI: adjacent GenBI competitor | Semantic/query pipeline and evaluation against expected SQL/results; evaluation documentation specifies paid plan availability [1] | A new analytics UI faces established workflows | Focus on reusable governance interfaces and independently verifiable execution evidence |
| Databricks Genie: native platform competitor | Curated context, metric views, certification, benchmark questions and result-based evaluation [2] | Semantic authoring and testing are already product features | Support imported definitions and held-out tests; avoid claims that all platforms lack business semantics |
| Snowflake Cortex Agents: native platform competitor | Semantic modeling, assisted generation, orchestration and resource budgets [3] | Bundled native governance reduces the need for an extra gateway in single-platform deployments | Validate whether customers need consistent policies across tools/engines |
| Google BigQuery data agents: direct competitor in first target engine | Verified queries, business glossary context, per-query maximum billed bytes and project/user quotas [4] | Dry-run and SQL generation alone provide limited differentiation | Reuse warehouse limits; add version-bound approval and cross-agent attribution |
| AWS AgentCore: horizontal governance competitor | Authenticated gateway, identity propagation, session-aware temporal policies and tracing [5] | Generic agent governance is competitive too | Specialize in semantic releases, SQL execution contracts, and data-cost evidence |
| NVIDIA Auto Ontology: complementary upstream with overlapping scope | Ontology/context generation, user-scoped MCP, certification/management and query interfaces [6] | Upstream already has governance-related capabilities | Verify existing lifecycle behavior; preserve provenance and map trust states instead of assuming no approval exists |
| dbt Semantic Layer: complementary semantic provider | Governed metrics exposed to AI through MCP [7] | Customers already own metric definitions | Import/reference approved definitions; avoid requiring duplicate authoring |

## 4. Market trends and implications

1. Semantic context is becoming a native analytics capability. Invest in review,
   release compatibility and provenance rather than another unrestricted metric editor.
2. MCP expands distribution but also the authorization surface. Use one policy
   path for REST and MCP; protocol support alone establishes no governance guarantee.
3. Evaluation is becoming expected. Publish reproducible control tests and
   result correctness tests separately; LLM judge scores are insufficient for access control.
4. Cost controls differ materially. Snowflake documents periodic budget enforcement
   with potential overspend; BigQuery documents per-query limits with billing-mode
   constraints [3][4]. Expose capabilities and limitations per engine.
5. Native identity/audit systems are substantial competitors. Integrate them and
   demonstrate measurable cross-tool value before adding a separate control layer.

These observations do not establish commercial demand or a defensible moat.

## 5. Verified implementation baseline

- Public release baseline: v0.1.0. Existing clause mapping records 4 implemented,
  12 partial, and 5 planned entries (20 rubric clauses plus proposed C5.5).
  This is the repository's July assessment, not a fresh conformance audit.
- Existing code: schema-aware generation patterns, BigQuery dry-run, policy checks,
  review workflow, OAuth/admin routes, and D1 query/audit records. Review end-to-end
  execution before describing every stage as production-enforced.
- Source inspection found maximumBytesBilled configuration in lib/bigquery.ts.
  Preserve it and test execution paths; organization budget admission is separate.
- PR #2 is merged and CI passed. It adds a local semantic registry CLI with
  ordered lifecycle transitions, release IDs, definition integrity checks and
  query binding records. The prior local test run passed 77 tests across 16 files.
- The CLI trusts operator-supplied identity, permissions and schema revisions.
  It does not authenticate callers, verify SQL uses the metric, execute SQL,
  or integrate NVIDIA. Do not upgrade conformance status on this basis.

## 6. Target workflow and architecture

Authenticated request -> authorized Semantic Release -> structured action plan ->
validation and cost reservation -> Approval Contract -> execution-time recheck ->
adapter execution -> Evidence Receipt and cost reconciliation.

### 6.1 Core objects

| Object | Required content | Lifecycle and invariants |
|---|---|---|
| Semantic Release | Schema version, release ID, tenant/domain, immutable definition digest, source revisions, provenance, owner, approval evidence, publication time | Candidate -> validated -> approved -> released -> deprecated/revoked. Changes produce a new release; rollback publishes an audited reference to an eligible prior definition. Record applicability and compatibility. |
| Approval Contract | Schema version, contract ID, tenant, original principal, agent/delegation, action type, target, canonical action and parameter digest, semantic release ID, policy revision, conditions, expiry, budget reservation, approval mode and authority | Proposed -> authorized -> consumed/completed, expired, revoked, or denied. Human review or an explicit policy grant supplies authority. Policy grants remain auditable. Bound content changes require new authorization. |
| Evidence Receipt | Schema version, receipt ID, intent/contract/release references, actor and agent, adapter/job ID, decision, outcome, timestamps, action digest, policy revision, estimated/actual/pending cost, evidence references, integrity metadata | Durable pending record before external execution; append outcome events after execution. Issued snapshots are immutable; corrections/reconciliation append superseding records. Failure, denial and cancellation remain visible. |

Denied requests may have no authorized contract or semantic release. Their
receipt includes the request/intent ID, available references, and missing-reference
reason rather than inventing successful authorization. Do not log credentials or
unrestricted result data. A receipt attests recorded facts within a declared trust
boundary; a digest alone does not prove correct execution or independent trust.

### 6.2 Contract enforcement

Define canonical serialization, parameter types, digest algorithm and schema
version before producing signatures or interoperable object IDs. Verify tenant,
signature/authenticity where applicable, issuer, audience, scope and expiry.
At execution, recheck current permissions, revocation, semantic/source eligibility,
policy changes and budget. A policy revision change requires reauthorization in
the first implementation. Never treat possession of a receipt as permission.

Consume authorization and reserve capacity atomically where possible. Associate
retries with one intent and idempotent warehouse job identity. Define crash
recovery and reconciliation for external jobs; do not promise distributed
exactly-once execution. Multi-step actions require bounded child contracts or
an explicitly authorized plan; retries cannot silently expand scope.

### 6.3 Implementation boundaries

Use existing TypeScript, Next.js, Workers and D1 components. Keep execution and
policy logic server-side. Use a proven SQL parser for supported dialects; do not
base production authorization on regex matching. Use parameterized queries.

Primary APIs and storage models are named for the three objects. Supporting
records include tenant, principal, agent, source, candidate, validation, execution
intent, budget reservation, job and audit event. Every cross-record lookup is
tenant-scoped. REST and MCP call the same authorization/execution service.

Adapters declare supported action types, semantic binding, estimation, limits,
cancellation and evidence retrieval. Unsupported guarantees cause rejection or
an explicit restricted mode. The first UI manages releases, contracts and
receipts; free-form chat is secondary to this control workflow.

D1 stores durable metadata and migrations. For budget coordination, evaluate
transactional conditional updates versus a Durable Object per budget scope;
select one after concurrency/crash tests. Do not rely on process memory or a
read-then-write counter. Warehouse permissions remain an independent boundary.

## 7. Delivery plan

Planning assumption: two full-time engineers plus part-time product/data-owner
and security review. Weeks start after staffing and pilot access are confirmed.
For one engineer, reduce scope or re-estimate; do not promise the same timeline.
Version labels below are provisional and supersede sequencing, not existing releases.

| Phase | Window | Scope and dependencies | Exit criteria |
|---|---|---|---|
| P0: establish contracts | Weeks 1-2 | Audit code/auth; define versioned schemas and trust boundaries for all three objects; interview 5 teams | Capability inventory; canonicalization and state-machine fixtures; 2 pilot commitments; no simulated production success |
| P1: Semantic Release service | Weeks 3-5 | D1, authenticated tenant-scoped API, review UI, provenance, validation evidence and immutable releases | Cross-tenant actions denied; changed content invalidates approval; drift/revocation and concurrent transitions tested |
| P2: Approval Contract execution | Weeks 6-8 | Structured metric compiler/templates, canonical intent, policy/human grants, expiry/revocation, cost reservation and BigQuery adapter | Every execution has an eligible contract; changed content cannot reuse it; recheck current authority; crash/retry reconciliation tested; minimum durable receipt linked |
| P3: Evidence Receipt completion | Weeks 9-10 | Cost reconciliation, append-only outcomes, export verification, retention, cancellation, held-out tests | Success/failure/denial/cancellation evidence complete; pending costs explicit; concurrent budget admission tested; receipt integrity/export verification demonstrated |
| P4: Gateway preview and pilot | Weeks 11-12 | Shared REST/MCP controls; deployment docs; two pilot deployments; independent verifier tool | Two clients use same policy path; owners manage three objects without developer edits; reports quantify coverage, bypass attempts and operational gaps |

Do not force a release at week 12 if a control gate fails. Publish a preview with
explicit limitations rather than relabeling partial controls as complete.

The 12-week cycle targets the Gateway gate below, not the Control Plane,
Protocol or Standard stages. Subsequent stages have no committed dates.

## 8. Work packages and acceptance tests

| Work package | Priority | Essential tests |
|---|---|---|
| Production mode and auth | P0 | Missing credentials fail closed; demo mode visibly distinct; read/write authorization checked server-side |
| Object schemas and compatibility | P0 | Canonicalization vectors, unknown versions, malformed references, tenant mismatches, schema migration and immutable history |
| Semantic registry | P0 | Invalid transitions, owner changes, tenant isolation, drift, deprecated release, concurrent release, historical integrity |
| SQL/metric binding | P0 | Metric expression substituted by client, hidden joins, forbidden columns, stale schema, SQL injection, parameter tampering |
| Approval Contract | P0 | TOCTOU permission change, policy/source revision change, expiry, revocation, parameter tampering, replay, bounded delegation, crash recovery |
| Budget ledger | P0 | Parallel requests, retry reuse, timeout, partial billing, late actual cost, cancellation, model/tool cost outside SQL estimate |
| Evidence Receipt | P0 | Attempt/outcome linkage, denial without contract, tampered export, missing events, pending costs, appended correction, key rotation where signed, retention and recovery |
| NVIDIA adapter | P1 after registry contract | Version-pinned import fixture, provenance retained, upstream certification mapped explicitly, no auto-release |
| Second engine | P1 after pilot | Capability matrix, equivalent authorization tests, honest unsupported cost operations |
| Long-term memory, charts, many agents | P2 | Schedule only after reliable execution and evidence are demonstrated |

Permission-aware context retrieval precedes generation. Store machine-verifiable
decision inputs and concise rationale; do not require private model reasoning logs.
Audit delivery needs durable retry/outbox handling; tracing sampling must not
drop required audit records.

## 9. Measurement and evaluation

Proposed preview dataset: 100 held-out synthetic/public-data scenarios spanning
numerical correctness, ambiguity, lifecycle, authorization, approvals, costs and
recovery. Publish category counts and fixtures before running; keep question
templates and development examples out of the holdout set.

Release gates: all enumerated authorization/lifecycle/budget invariant tests pass;
any bypass blocks release. This is a finite test guarantee, not proof of universal
safety. Report answer accuracy separately, including abstentions and invalid SQL.

Proposed performance targets, to validate on declared hardware/data: p95 gateway
control overhead below 300 ms excluding model, warehouse and human time; evidence
receipt available within 5 seconds after job finalization under normal operation.
Publish observed values, concurrency and failures instead of presenting targets
as achieved benchmarks.

Pilot metrics: time to first governed query, time to approve a definition, review
reversal rate, abandoned approval requests, unaccounted cost records, integration
effort, repeated weekly use, and willingness to maintain/deploy the gateway.

Object metrics: proportion of governed executions bound to an eligible Semantic
Release; proportion authorized by a valid Approval Contract at execution;
proportion of admitted attempts with a durable intent and reconciled Evidence
Receipt. Publish denominators, exclusions, pending jobs and missing evidence.
For admitted production traffic, target complete contract and intent coverage;
any ungoverned execution is a release blocker, not an averaged quality score.

## 10. Product boundaries and adoption

Initial offer: self-hostable, source-visible governed BigQuery workflow with a
small reference UI and documented API. Keep deployment instructions repeatable,
sample data synthetic, and metadata export usable without the application.

Potential commercial hypothesis: managed deployment, enterprise identity,
policy operations and support. Validate demand before defining paid tiers.
No pricing, TAM or revenue forecast is justified by this research.

Avoid a framework rewrite, Kubernetes requirement, new vector database, custom
query engine, broad write access, or many warehouse connectors in the first cycle.
Choose PostgreSQL or Trino as the second engine based on pilot evidence.
An Iceberg claim requires a real engine/catalog path and tested behavior.

## 11. Immediate next actions

1. Refresh main locally and inventory release vs development capabilities.
2. Create epics for Semantic Release, Approval Contract and Evidence Receipt,
   with supporting auth, budget, adapter and evaluation issues.
3. Agree on versioned object schemas, state machines, canonicalization,
   verification and source/semantic/approval interfaces before implementing UI.
4. Deliver one tenant-scoped candidate-to-release API flow with migrations/tests.
5. Revalidate the July clause mapping only for demonstrably completed behavior.
6. Publish release notes and sync the website after a tagged release or merged
   capability change; identify proposals, previews and releases separately.

This document is a local planning deliverable. Creating issues, changing public
roadmaps, publishing it, or deploying features are separate execution steps.

## 12. Progression gates

Each gate needs a dated evidence bundle, public limitations, named reviewers,
and an explicit decision. Passing one gate does not automatically pass the next.
The numeric thresholds below are proposed management criteria, not industry facts.

| Stage | Required evidence to claim the stage | Evidence insufficient on its own |
|---|---|---|
| ODAP Gateway | One authenticated read-only adapter executes the three-object workflow; all declared control tests pass; crash recovery and evidence export verified; two independent client integrations; two external pilot teams complete acceptance | CLI lifecycle demo, SQL generation, MCP endpoint, or test count alone |
| ODAP Control Plane | At least two execution adapters and two independently built agent clients share schemas and policies; central lifecycle/revocation/budget operations demonstrated; two external teams operate pilot workloads for 30 days with coverage and incident reports | Two UI screens, renamed APIs, or connectors bypassing common enforcement |
| ODAP Protocol | Public versioned wire schemas and semantics; canonicalization and issuer/verifier trust rules; capability negotiation and compatibility policy; conformance fixtures; at least two independently developed implementations exchange and verify all three objects with documented scope | A REST/OpenAPI specification, MCP support, or two deployments of the same implementation |
| ODAP Standard | Independent adopters across at least three organizations; public governance, conflict disclosure, change/appeal process, version compatibility, independent interoperability review and sustained maintenance | Founder declaration, repository popularity, publication, or one vendor passing its own tests |

Existing ODAP Five Musts remain the principles. A future protocol can implement
those principles; these gates do not rename existing documents or claim formal
standards-body recognition. Any new normative requirements need their own open
proposal and review process. Avoid certification claims before an independent,
documented certification mechanism exists.

Advance beyond read-only data actions only when pilot demand identifies a
specific action family and reviewers approve its authorization model, side-effect
handling, compensation/recovery behavior and evidence semantics. General
enterprise action governance remains a longer-term hypothesis.

## Sources

1. [Wren evaluation](https://docs.getwren.ai/cp/guide/evaluation/overview) and
   [Wren AI Service](https://docs.getwren.ai/oss/concept/wren_ai_service).
2. [Genie concepts](https://docs.databricks.com/gcp/en/genie-agents/concepts),
   [benchmarks](https://docs.databricks.com/gcp/en/genie-agents/monitor), and
   [certification](https://docs.databricks.com/gcp/en/genie-agents/set-up).
3. [Snowflake semantic modeling](https://docs.snowflake.com/en/user-guide/views-semantic/best-practices-modeling)
   and [resource budgets](https://docs.snowflake.com/en/en/user-guide/snowflake-cortex/cortex-agents-resource-budgets).
4. [BigQuery conversational analytics](https://docs.cloud.google.com/bigquery/docs/conversational-analytics)
   and [agent cost limits](https://docs.cloud.google.com/gemini/data-agents/conversational-analytics-api/manage-costs).
5. [AgentCore identity/session policy](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/policy-session-based-temporal.html)
   and [policy observability](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/observability-policy-metrics.html).
6. [NVIDIA Auto Ontology](https://github.com/NVIDIA/auto-ontology).
7. [dbt Semantic Layer](https://docs.getdbt.com/docs/use-dbt-semantic-layer/dbt-sl).
8. [Gateway clause mapping](https://github.com/open-data-agent-platform/odap-gateway/blob/main/ODAP_CLAUSE_MAPPING.md)
   and [merged prototype PR #2](https://github.com/open-data-agent-platform/odap-gateway/pull/2).
