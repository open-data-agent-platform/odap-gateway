# ODAP Gateway

ODAP Gateway is the reference implementation of the ODAP Five Musts: Open,
Semantic, Governed, Auditable, and Cost-controlled.

It provides a governed gateway for AI agents querying enterprise data, starting
with BigQuery dry-run workflows. The repository focuses on the implementation
layer: policy checks, schema governance, approval workflows, audit records, and
cost controls. Product website, brand, billing, and commercial hosting layers
are intentionally kept outside this open-source package.

## Scope

- SQL generation and validation engine
- BigQuery dry-run integration
- Schema catalog and field policy controls
- Workspace allowlist and approval workflow
- Query run audit records
- Admin review APIs
- Google and GitHub OAuth flow scaffolding
- Cloudflare D1 schema for governance and audit data
- Tests for the gateway policy, auth, admin, schema, and dry-run layers

## Not Included

- Product website and marketing pages
- Billing, checkout, Stripe webhook, and paid-plan management
- Production Cloudflare routes, D1 database IDs, OAuth client IDs, or secrets
- Private development history

## Commands

```bash
npm install
npm run lint
npm run typecheck
npm run test
npm run build
```

For Cloudflare Workers validation, copy `wrangler.example.jsonc` to your own
local config and add real resource IDs and routes outside version control.

## Environment

Copy `.dev.vars.example` to `.dev.vars` and replace placeholders with your own
values. OAuth client IDs and secrets, BigQuery service-account keys, and cookie
secrets must never be committed.

## License

Apache-2.0. See `LICENSE`.
