# ODAP Gateway Workers Deployment

This document describes a starter Cloudflare Workers deployment for the ODAP
Gateway reference implementation.

## Worker

- Worker example name: `odap-gateway-worker`
- Static assets: `out/`
- Worker entry: `worker/index.ts`
- D1 binding: `ODAP_GATEWAY_DB`
- D1 database: create your own D1 database and set its ID locally
- Config template: `wrangler.example.jsonc`

`wrangler.example.jsonc` intentionally uses placeholder routes and database IDs.
Do not commit production routes, account-specific IDs, administrator emails, or
secrets.

## Deploy

```bash
npm run build
npm run worker:dry-run
```

For a real deployment, copy `wrangler.example.jsonc` to a private local config,
then set your own Worker name, routes, D1 database ID, and administrator
allowlist.

`AUTH_COOKIE_SECRET` must be stored as a Worker secret. Google and GitHub OAuth
credentials must also be stored as Worker secrets before real login works:

```text
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
GITHUB_CLIENT_ID
GITHUB_CLIENT_SECRET
```

The `assets.run_worker_first` list must include `/admin*` and `/api/*`. Without
that setting, Cloudflare can serve static admin assets before the Worker has a
chance to enforce OAuth admin access.

## BigQuery Dry Run

The `Run` button calls `/api/query/dry-run`. In production this endpoint should
use a Google service account to perform a BigQuery dry-run only; it does not
execute result-producing jobs.

Store these as Worker secrets or environment variables:

```text
BIGQUERY_PROJECT_ID
BIGQUERY_CLIENT_EMAIL
BIGQUERY_PRIVATE_KEY
BIGQUERY_LOCATION
BIGQUERY_MAX_BYTES_BILLED
```

`BIGQUERY_PRIVATE_KEY` should be the PKCS#8 private key from the service account
JSON. Escaped `\n` line breaks are supported. If the BigQuery values are not
configured, the endpoint returns `mode: "simulated"` and clearly labels that no
live BigQuery call was made.

Recommended service-account permissions:

- BigQuery Job User on the project where dry-run jobs are created.
- Read permissions for datasets that should be available to ODAP Gateway.

After changing D1 schema or Worker secrets, validate:

```bash
npm run lint
npm run typecheck
npm run test
npm run build
npm run worker:dry-run
```
