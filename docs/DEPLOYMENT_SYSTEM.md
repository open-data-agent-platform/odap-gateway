# ODAP Gateway Deployment System

ODAP Gateway uses a conservative release model for governed data access:

- Develop on short branches.
- Run lint, typecheck, tests, and build before deployment.
- Validate the Worker with a dry run before binding production routes.
- Keep D1 schema changes reviewable and reversible.
- Store all secrets outside the repository.

The open-source repository intentionally excludes product website deployment,
billing, paid checkout, and production hosting configuration.
