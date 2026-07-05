# ODAP Gateway OAuth Setup

ODAP Gateway uses OAuth callbacks and HttpOnly signed sessions for admin access.
The implementation supports Google and GitHub providers, but all client IDs and
client secrets must be supplied by the deployer.

## Callback URLs

Use your own deployment origin:

```text
https://your-domain.example/api/auth/callback/google
https://your-domain.example/api/auth/callback/github
```

For local development:

```text
http://localhost:3000/api/auth/callback/google
http://localhost:3000/api/auth/callback/github
```

## Required Secrets

```text
AUTH_COOKIE_SECRET
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
GITHUB_CLIENT_ID
GITHUB_CLIENT_SECRET
```

`ADMIN_EMAILS` is an allowlist variable and should contain deployer-controlled
administrator email addresses. Use example addresses in public fixtures.

## D1

Create a D1 database for governance and audit data, then apply `db/schema.sql`.

```bash
npx wrangler d1 create odap-gateway
npx wrangler d1 execute odap-gateway --file db/schema.sql --remote
```

Bind the database as `ODAP_GATEWAY_DB`.
