# Security Policy

ODAP Gateway is a reference implementation for governed agent data access. Treat
all database access, OAuth configuration, and Worker secrets as deployment-local
responsibilities.

## Reporting

Please open a private security advisory in the GitHub repository when available,
or contact the maintainers listed by the Open Data Agent Platform organization.

## Sensitive Data Rules

- Never commit OAuth client secrets.
- Never commit service-account private keys.
- Never commit production D1 database IDs.
- Never commit real administrator allowlists.
- Use BigQuery dry-run permissions before enabling any execution path.
- Keep `/admin*` and `/api/*` routed through the Worker before static assets.
