# Release Notes

## v0.1.0 - Initial open-source release

First public release package of a reference implementation of the
[ODAP Five Musts](https://github.com/open-data-agent-platform/awesome-odap):
a governed gateway for AI agents querying enterprise data, starting with BigQuery.

**What's in the box**

- Schema-aware Text-to-SQL over approved demo schema context
- BigQuery dry-run cost estimation before execution
- Approval workflow, audit trail, and role-based access primitives
- Cloudflare Workers + D1 + Next.js stack

**Standard conformance**

Mapped clause-by-clause, including honest gaps, in
[ODAP_CLAUSE_MAPPING.md](ODAP_CLAUSE_MAPPING.md):
4 Implemented | 12 Partial | 5 Planned.

**Known boundaries**

Early-stage. APIs subject to change. BigQuery-only by design. One-command
Docker demo lands in v0.2; see [ROADMAP.md](ROADMAP.md).

Challenges to any clause status are welcome via issues.
