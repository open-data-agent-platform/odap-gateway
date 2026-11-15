# PostgreSQL host connector preview

`integrations/postgresql/index.ts` implements a restricted Node.js read connector.
It is **not exposed by the Gateway REST/MCP service**, not a production connector,
and not evidence of complete governed PostgreSQL support. The capability inspector
continues to refuse PostgreSQL dispatch. No production schema changes are needed
for this preview.

## Supported slice

- Exact PostgreSQL 17.12 and `pg` 8.23.1. Other server versions fail closed.
- One ordinary, non-inherited, non-partitioned table with active RLS.
- Released single-table `COUNT_ROWS` or `SUM` of `bigint`/`numeric`.
- Equality filters for built-in `text`, `boolean`, `bigint`, `numeric` only.
  NULL matches NULL using `IS NOT DISTINCT FROM`; false is not NULL.
- Tenant predicate is mandatory, uses a bound parameter and `C` collation,
  and supplements rather than replaces database RLS.
- Aggregates return exact decimal strings or null, never floating-point numbers.
  Empty COUNT is `"0"`; empty SUM is null. Nonfinite/over-256-character results
  fail closed. Date/time, arrays, JSON, domains, custom types, joins, arbitrary SQL,
  functions, views, foreign tables and pagination are not supported.

The local `odap.postgresql-metric.v1` definition contains `tenantId`,
`sourceRevision`, `target`, `metricId`, `table`, `measure` and `filters`.
`table` binds `database`, `schema`, `name`, `tenantColumn`.
`measure` is `{aggregate:"COUNT_ROWS"}` or
`{aggregate:"SUM",column:"amount",type:"INT64"}` (also `DECIMAL`).
Each filter binds `{column,type}`. Identifiers are strict ASCII, at most 63 bytes.
The release digest and `odap.metric-read.v1` action are checked before connecting.
These are local engineering formats, not changes to the ODAP specification.

## Host responsibilities

The host must resolve the configuration and release from trusted storage, never
from an Agent-supplied endpoint, role, SQL string or credential. All connection
fields are explicit. TLS verifies certificates; unencrypted connections are only
accepted with explicit `insecureLoopback: true` and host `127.0.0.1` for fixtures.
The CI configuration uses disposable, synthetic credentials, not business secrets.

`executePostgresMetric(config, read, claim, signal)` prepares the read, verifies
actual database/role/server/table/column metadata and only then calls `claim`.
The callback receives frozen database, role, action, definition and statement
bindings. It **must atomically recheck current authority and reserve/record the
exact read in host storage**, with uniqueness and stale-authority protection.
Returning true is not itself an authorization mechanism. The connector has no
durable deduplication or authorization ledger of its own. The callback must also
have its own bounded deadline; arbitrary host callback execution is not cancellable.

Each call uses a dedicated connection, a read-only repeatable-read transaction,
fixed `pg_catalog` search path, active RLS and an access-share table lock. Superuser,
BYPASSRLS, role/database administrators, replication roles, table-owner membership,
and table/column write privileges are rejected. Required column OIDs are restricted
to built-in types. Database owners and administrators must be trusted: RLS policies,
extensions, functions and server configuration are outside this preview's sandbox.
PostgreSQL itself notes that read-only transactions do not prevent all side effects.
[Read-only semantics](https://www.postgresql.org/docs/17/sql-set-transaction.html),
[RLS semantics](https://www.postgresql.org/docs/17/ddl-rowsecurity.html).

## Failure semantics

The driver does not retry submissions. A denied/unknown claim never sends the
metric. Successful results require query and transaction cleanup acknowledgements.
Any failure after a send attempt, including timeout, disconnect, permission
revocation or abort, returns `observation-required`. It is not permission to refund,
retry, publish a terminal receipt or claim successful cancellation. An abort closes
only this call's connection; the preview does not prove the server query stopped.
Errors returned to callers are bounded reason codes, not raw driver errors or SQL.

Statement and lock timeouts are server controls; the connection deadline bounds
driver work. These are **not** billed-cost, scanned-row, memory or whole-transaction
resource guarantees. A one-row aggregate can scan many rows. No optimizer-cost-to-
money conversion is made. Node-postgres requires all transaction operations on the
same connection, as used here.
[Driver transaction guidance](https://node-postgres.com/features/transactions).

## Verification and remaining work

`npm test` runs pure compiler tests. `npm run test:postgresql` requires a new,
disposable PostgreSQL 17.12 fixture at `127.0.0.1:55432`, database
`odap_pg_fixture`, plus `ODAP_POSTGRES_FIXTURE=isolated-synthetic-only`.
Do not run it against an existing database: setup creates roles/schema/tables and
intentionally fails if they already exist. The CI `postgresql-integration` job
pins the official Linux amd64 image digest and publishes the real test and server
reports. Missing service, wrong version, failed setup or process exit is a failure,
not a skip. TLS production verification is not part of this loopback test.

Remaining before full Gateway PostgreSQL acceptance: authoritative source/role/
tenant provisioning; durable contract, resource reservation and dispatch binding;
cross-process idempotency and recovery; provider observation/cancellation evidence;
receipt settlement; common REST/MCP path; TLS/deployment tests; independent review
and authorized pilot. Existing synthetic examples and author tests are not
independent signoff or formal scoring.
