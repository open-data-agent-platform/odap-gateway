# Contributing

Thanks for helping improve ODAP Gateway.

Please keep contributions focused on governed agent access to enterprise data:
schema controls, dry-run cost checks, approval flows, auditability, deployment
hardening, and clause mapping accuracy.

Before opening a PR:

- Run `npm run typecheck` and `npm run test`.
- Use demo data only in screenshots, fixtures, and recordings.
- Do not commit `.env`, `.dev.vars`, credentials, private project IDs, or real
  customer/user data.
- If you change behavior that maps to the ODAP Rubric, update
  `ODAP_CLAUSE_MAPPING.md`.
