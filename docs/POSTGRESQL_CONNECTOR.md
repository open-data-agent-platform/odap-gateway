# PostgreSQL governed host integration

`integrations/postgresql/index.ts` implements the restricted Node.js read connector.
`control.ts` connects it to persisted Gateway authority, and `gateway.ts` supplies
authenticated REST and post-initialization MCP command hooks. This is a **Node host
integration**, not a deployed Cloudflare Worker query endpoint or full PostgreSQL
SQL/type coverage. The offline inspector still refuses production Gateway dispatch.
Migration `0035_postgresql_control.sql` is opt-in and has not been applied to the
production D1 database. Existing production migration restrictions still apply.

## Supported slice

- Exact PostgreSQL 17.12 and `pg` 8.23.1. Other server versions fail closed.
- One ordinary, non-inherited, non-partitioned table with active RLS.
- Released single-table `COUNT_ROWS` or `SUM` of `bigint`/`numeric`.
- Equality filters for built-in `text`, `boolean`, `bigint`, `numeric` only.
  NULL matches NULL using `IS NOT DISTINCT FROM`; false is not NULL.
  Text and tenant parameters reject NUL and ill-formed Unicode before UTF-8 encoding.
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

For governed use, call `executeGovernedPostgresRead(access, requestId, resolver,
signal)` or mount `createPostgresGateway({origin, env, resolve})` in an authenticated
Node host. `env` uses the existing session verifier and D1-compatible control-store
interface; Node hosts must provide a durable compatible binding. There is no
fallback to demo identity, CLI email, caller principal, or an Agent permission flag.
The host must bound concurrent requests and supply TLS termination, OAuth session
issuance, and MCP session/protocol initialization. This hook does not implement a
standalone MCP server, autonomous-agent delegation or an OAuth provider.

The operator provisions an immutable `postgresql_read_budgets` row and a
`postgresql_source_versions` row for the explicit tenant, designated owner,
connection reference, database/schema/table/tenant column, role, budget and expiry.
The `postgresql_source_heads` pointer activates that version. No registry rows are
automatically seeded. Source or role changes require a new version and fresh review.
Use `postgresConnectionDigest(tenantId, config)` for the binding digest: it includes
endpoint, role, TLS trust and timeouts, but excludes the password. The resolver
receives the stored tenant/reference, not request-supplied connection parameters.
Do not place passwords or connection strings in the registry or public evidence.

### Governed lifecycle

1. `propose`, `review`, `validate`, `approve-revision`, `publish` use the existing
   immutable candidate/release records. The source's designated current owner must
   validate and approve the exact definition digest and evidence reference.
2. `request` compiles the exact released action and persists its action/statement
   digests. `approve-read` requires the designated owner, a different requester,
   and the exact reviewed action, requester, release and source version. It creates
   the standard ApprovalContract with a ten-minute database-clock expiry.
3. `execute` resolves the bound host, preflights PostgreSQL, then atomically checks
   current tenant membership, source, owner, release, expiry, stop markers, contract
   state and quota. One unique claim consumes the contract and one read attempt,
   and writes a pending EvidenceReceipt in the same transaction.
4. Successful query and cleanup acknowledgements append a success observation and
   receipt. No values, credentials or raw SQL are persisted in receipts. A lost
   storage acknowledgement suppresses the value response; `inspect` reads durable
   state without resubmitting. Pending and observed receipts are never overwritten.
5. `stop` blocks future claims; it does not prove cancellation of an already-claimed
   query. `retire` blocks new claims for a release. Uncertain claims are never rearmed
   or automatically refunded. There is no distributed exactly-once claim.

Quotas are explicitly **read-attempt counts, not currency or scanned-row limits**.
Approvals do not reserve a future slot; quota is atomically acquired with the claim,
and competing approved requests may be refused. All responses report monetary cost
as `unpriced`. The session client is labeled `postgresql-session`, not represented
as an independently verified Agent. Formal cost settlement and autonomous-agent
authority remain unsupported and must not be inferred from this workflow.

### Transport contract

POST `/postgresql/{tenant}/{command}` with JSON, a verified session cookie and the
exact configured Origin. Unknown fields and commands are rejected. These are Node
host-relative paths, not new routes on `googlesql.com/gateway`.
`gateway.ts` defines each command's exact input fields. The MCP host hook uses POST
`/postgresql/{tenant}/mcp`, JSON-RPC `tools/list` and `tools/call`; tool names prefix
`postgresql_` and replace command hyphens with underscores. Both transports invoke
the same command services. Source registration, result observation and caller-
asserted authorization are intentionally not public commands.

The host must resolve the configuration and release from trusted storage, never
from an Agent-supplied endpoint, role, SQL string or credential. All connection
fields are explicit. TLS verifies certificates; unencrypted connections are only
accepted with explicit `insecureLoopback: true` and host `127.0.0.1` for fixtures.
The CI configuration uses disposable, synthetic credentials, not business secrets.

`executePostgresMetric(config, read, claim, signal)` prepares the read, verifies
actual database/role/server/table/column metadata and only then calls `claim`.
The low-level callback receives frozen database, role, action, definition and statement
bindings. It **must atomically recheck current authority and reserve/record the
exact read in host storage**, with uniqueness and stale-authority protection.
Returning true is not itself an authorization mechanism. The connector has no
durable deduplication or authorization ledger of its own. The governed wrapper
supplies that ledger and a bounded claim deadline. A custom callback must also
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
not a skip. CI also generates an ephemeral synthetic TLS certificate, tests its
trusted IP SAN and rejects untrusted CA/hostname mismatches before claims. Only
the public certificate is read by tests; private key bytes are not printed,
committed or uploaded. A local fixture needs the same TLS setup under
`.tmp/postgresql-tls/`. This is not TLS production verification.
[PostgreSQL TLS configuration](https://www.postgresql.org/docs/17/ssl-tcp.html),
[node-postgres TLS handling](https://node-postgres.com/features/ssl).

SQLite and native D1 tests cover the persisted review/approval/claim/receipt path,
tenant/owner isolation, concurrent claims, quota exhaustion, withdrawal of authority,
append-only storage and receipt-write rollback. Real PostgreSQL tests exercise the
governed host path, REST/MCP, concurrency, resolver substitution and lost claim or
observation acknowledgements. These are author engineering tests, not independent
signoff, formal scoring or a real pilot.

Still required for full acceptance: approved production catalog/auth/host setup and
schema rollout; autonomous Agent delegation; independently verifiable terminal
cancellation/reconciliation; a reviewed monetary pricing/settlement model; broader
SQL/type/version coverage where required; independent review and an authorized
pilot. Do not enable the general adapter inspector by merely listing this host hook.
