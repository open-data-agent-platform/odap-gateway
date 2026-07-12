# ODAP Gateway Workers Deployment

This package is prepared for Cloudflare Workers with D1 and static assets.

## Local setup

```bash
cp .dev.vars.example .dev.vars
cp wrangler.example.jsonc wrangler.jsonc
npx wrangler d1 create odap-gateway-db
npx wrangler d1 execute odap-gateway-db --file=db/schema.sql
npm run build
npx wrangler deploy
```

## Required bindings

- D1 binding: `ODAP_GATEWAY_DB`
- Static assets binding: `ASSETS`

## Secrets

Store OAuth client secrets, cookie signing values, and BigQuery private keys as
Worker secrets or local `.dev.vars` values. Do not commit real values.

## BigQuery

Grant the service account the minimum permissions needed for dry-run jobs and
metadata reads over the datasets you want ODAP Gateway to govern.
