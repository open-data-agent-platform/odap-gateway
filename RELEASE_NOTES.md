# Release Notes

## v0.2.0-preview.1 - Governed Gateway preview

This is a prerelease, not a declaration of production readiness or completed
independent acceptance. APIs remain subject to change.

**Changes since v0.1.0**

- Tenant-scoped semantic review, explicit approval, publication, withdrawal and
  retirement, with immutable evidence links and write-time authority checks.
- Scoped contract requests, owner grants, delegation, budget admission and
  observation-only recovery of ambiguous provider handoffs.
- Receipt inspection, append-only audit evidence, corrections and local export
  verification; missing evidence and pending costs remain explicit.
- Fail-closed production authentication, verified initial-role email contact,
  browser-bound single-use OAuth state, transactional legacy mutations and
  bounded provider responses.
- Configurable path hosting, including `/gateway`, across navigation, static
  assets, APIs, acknowledgments and OAuth callback URLs.

**Known boundaries**

Live OAuth credentials and explicit administrator enrollment require environment
configuration. External pilot reports, independent client integrations,
retention/custody verification and a separately held-out evaluation remain open.
Developer-visible fixtures and local/CI regression counts are not Gateway scores
or independent sign-off. Deploying this preview does not provision business data,
grant tenant access or authorize paid warehouse queries.

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

Early-stage. APIs subject to change. BigQuery-only by design.

Challenges to any clause status are welcome via issues.
