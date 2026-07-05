# Contributing

ODAP Gateway accepts contributions that improve governed agent data access:
policy checks, schema controls, auditability, dry-run cost controls, and
deployment hardening.

## Process

1. Open an issue describing the change.
2. Keep changes scoped and testable.
3. Add or update tests for behavior changes.
4. Run:

```bash
npm run lint
npm run typecheck
npm run test
npm run build
```

## Boundaries

Do not submit production secrets, customer data, production D1 IDs, OAuth client
IDs, OAuth client secrets, private keys, or administrator email allowlists.

Billing, checkout, paid-plan management, hosted commercial services, and product
website content are outside this repository.
