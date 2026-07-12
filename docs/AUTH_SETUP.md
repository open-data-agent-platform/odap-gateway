# ODAP Gateway OAuth Setup

ODAP Gateway uses OAuth callbacks and HttpOnly session cookies. Provider access
tokens are exchanged on the server and are not exposed to client code.

## Callback URLs

Use your local or deployed origin:

- Google: `http://localhost:3000/api/auth/callback/google`
- GitHub: `http://localhost:3000/api/auth/callback/github`

For a deployed Worker, replace the origin with your own domain.

## Environment variables

Copy `.dev.vars.example` to `.dev.vars` and fill in your own values:

- `AUTH_COOKIE_SECRET`
- `ADMIN_EMAILS`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GITHUB_CLIENT_ID`
- `GITHUB_CLIENT_SECRET`

Set `ADMIN_EMAILS` to a comma-separated allowlist such as
`admin@example.com,security@example.com`.

Never commit `.dev.vars`.
