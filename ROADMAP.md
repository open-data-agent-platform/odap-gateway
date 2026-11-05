# ODAP Gateway - Roadmap

Direction, not promises. Sequenced by what makes the reference implementation
more reference-worthy, not by feature demand.

## v0.1.x - now

- Initial open-source release package
- Clause mapping published (`ODAP_CLAUSE_MAPPING.md`)
- Hardening: demo fixtures, example configs, docs cleanup

## v0.2 - governance depth

- One-command local demo (Docker Compose)
- Sandbox validation on masked data (G3.4)
- Organization-level budget circuit-breakers (C5.2 full)
- Query rewrite suggestions with savings estimates (C5.4)

## v0.3 - semantic layer

- Business-editable metric definitions with ownership (S2.1)
- Confidence scoring per answer (A4.3)
- One-click audit replay (A4.4)

## Later - openness

- Iceberg / Delta Lake read support (O1.1)
- Second source beyond BigQuery (O1.2)
- Stable public API spec (O1.4)
- Energy/resource awareness, tracking proposed C5.5

Priorities can be challenged by issue.

## Proposed experiments - pending design review

Track [discussion #8](https://github.com/open-data-agent-platform/awesome-odap/issues/8)
and [the design proposals](https://github.com/open-data-agent-platform/awesome-odap/blob/main/docs/design-proposals.md).
These optional experiments are not v0.1.0 functionality or release commitments.

- Semantic candidates: stage generated definitions, preserve provenance, validate,
  require named human approval, and publish immutable releases. NVIDIA Auto
  Ontology is a possible adapter source; no integration is claimed today.
- Semantic use: bind queries to a released version; reject unreleased or
  unauthorized definitions. Schema drift triggers review instead of silent edits.
- Identity and session policy: preserve the original caller and tenant across
  tool calls, recheck execution permissions, and bound retries and delegation.
- Cost and audit: distinguish estimates, alerts, delayed blocking, admission
  limits, and cancellation. Correlate decisions, approvals, semantic/policy
  versions, jobs, and costs without exposing credentials or sensitive results.

Prototype acceptance uses synthetic/public data and held-out evaluation cases:
prove candidate-to-release behavior, tenant isolation, rejection of changed or
expired approvals, concurrent budget accounting, bounded retries, and complete
decision/execution audit links. Document any enforcement latency and overspend.
Update the clause mapping only after code and evidence justify a status change.
