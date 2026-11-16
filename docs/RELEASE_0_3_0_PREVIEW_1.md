# ODAP Gateway 0.3.0-preview.1

This prerelease brings the bounded PostgreSQL Node host into the numbered
Gateway release line alongside the existing BigQuery workflows. APIs may change.
It is not a completed Gateway acceptance or a production-readiness claim.

## PostgreSQL Scope

- A separate configured Node.js host, not a PostgreSQL endpoint in the hosted
  Cloudflare Worker. Released single-table COUNT_ROWS/SUM reads use tenant RLS,
  a read-only role, current authority, approval contracts and signed Agent delegation.
- Eleven built-in scalar equality-filter types, with exact numeric strings and
  distinct null results. Arbitrary SQL, joins, general row extraction, arrays,
  JSON, floating-point and custom types are outside this profile.
- Durable attempt quotas and unresolved-read concurrency reservations, bounded
  cancellation, process-failure recovery and no replay of uncertain queries.
- Owner-only bounded evidence export and detached checksum/consistency checking.
  This is not complete audit coverage, issuer authentication or provider verification.
- Restart-and-reauthenticate password rotation, verified with synthetic credentials;
  no hot reload or real business credential use.

## Verification

Synthetic real-engine CI covers exact PostgreSQL **15.20, 16.16, 17.12 and 18.7**
with Node.js **24.22.1** and `pg` **8.23.1**. Each build runs 96 cases covering
TLS, tenant isolation, approvals, session/Agent MCP clients, process termination,
cancellation, evidence export, refusals and password rotation. These are
engineering checks, not a Gateway score or independent sign-off.

The release candidate runs the full Gateway, native D1, Python integration and
four-build PostgreSQL CI gates. See the release's linked CI run for exact results.

## Deployment Boundaries

The hosted preview remains at <https://googlesql.com/gateway>. This release
updates its public content without enabling PostgreSQL queries, configuring
OAuth/admin identities, changing production database data or applying migrations.
Existing production raw-SQL dry-run and legacy schema-import refusals stay in place.

PostgreSQL cost is **unpriced**: attempt quotas are not monetary budgets or
settlement. Unknown outcomes remain observation-required; losing a process or
connection does not establish provider termination, refund quota or allow replay.
Production host setup, trusted operational evidence, independent review and real
pilot acceptance remain open. The ODAP Five Musts, Rubric and historical clause
mapping are unchanged.

## Links

- [PostgreSQL connector guide](POSTGRESQL_CONNECTOR.md)
- [Database adapter matrix](DATABASE_ADAPTERS.md)
- [Integration scopes](../integrations/README.md)
- [Deployment boundaries](WORKERS_DEPLOYMENT.md)
