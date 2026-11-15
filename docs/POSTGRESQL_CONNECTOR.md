# PostgreSQL governed host integration

`integrations/postgresql/index.ts` implements the restricted Node.js read connector.
`control.ts` connects it to persisted Gateway authority, and `gateway.ts` supplies
authenticated REST and post-initialization MCP command hooks. This is a **Node host
integration**, not a deployed Cloudflare Worker query endpoint or full PostgreSQL
SQL/type coverage. The offline inspector still refuses production Gateway dispatch.
Migrations `0035_postgresql_control.sql`, `0036_postgresql_agent_delegations.sql`,
`0037_postgresql_terminal_failures.sql`, `0038_postgresql_concurrency.sql` and
`0039_postgresql_cancellation.sql`
are opt-in and have not been applied to the production D1 database. Existing
production migration restrictions still apply.

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
standalone MCP server or an OAuth provider. Bounded Agent execution uses the
separate registered-key path below, not a human session impersonation.

The operator provisions an immutable `postgresql_read_budgets` row and a
`postgresql_source_versions` row for the explicit tenant, designated owner,
connection reference, database/schema/table/tenant column, role, budget and expiry.
An immutable `postgresql_concurrency_limits` row must also bind that tenant and
budget to an integer `limit_in_flight` from 1 to 1000. No limit is inferred from
the attempt quota. Missing concurrency configuration refuses new claims.
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
   reserves one unresolved-read slot, and writes a pending EvidenceReceipt in the
   same transaction. All sources and hosts sharing the same tenant/budget compete
   for this durable capacity; session and Agent claims use the same guard.
4. Successful query and cleanup acknowledgements append a success observation and
   receipt. No values, credentials or raw SQL are persisted in receipts. A lost
   storage acknowledgement suppresses the value response; `inspect` reads durable
   state without resubmitting. A bounded acknowledged provider failure appends a
   separate failed receipt. Pending and observed receipts are never overwritten.
5. `stop` blocks future claims; it does not prove cancellation of an already-claimed
   query. `cancel` requests delivery to an already-claimed query without asserting
   a terminal result. `retire` blocks new claims for a release. Uncertain claims are never rearmed
   or automatically refunded. There is no distributed exactly-once claim.

Quotas are explicitly **read-attempt counts, not currency or scanned-row limits**.
Approvals do not reserve a future slot; quota is atomically acquired with the claim,
and competing approved requests may be refused. All responses report monetary cost
as `unpriced`. The session client is labeled `postgresql-session`, not represented
as an independently verified Agent. Formal cost settlement and open-ended policy
grants remain unsupported and must not be inferred from this workflow.

### Durable concurrency

`postgresql_resource_usage` counts claims lacking a durable success observation
or acknowledged terminal-failure record. The claim trigger checks this count
against the immutable limit in the same write transaction as contract consumption
and the pending receipt. There is no process-local semaphore or separate release
counter to drift. A rolled-back claim/receipt reserves nothing. A terminal write
whose receipt rolls back does not release capacity.

Only persisted terminal evidence releases the unresolved-read slot. Timeout,
disconnect, host death, stop, consent/key revocation and approval expiry alone do
not release it. Lost terminal-write responses can still leave durable terminal
evidence; read-only inspection reports that state without retrying the query.
The consumed attempt and contract remain consumed even after capacity is freed.
No age-based lease expiry, automatic refund or administrative force-release API
is provided. Unresolvable claims can exhaust a scope until supported terminal
evidence is available; never clear them based only on backend disappearance.

Human `inspect` returns `limit_in_flight` and `unresolved_claims`; signed Agent
inspection returns `limitInFlight` and `unresolvedClaims`. Both label the unit
`unresolved-read-claim`. These are current budget-wide snapshots, not permission
or a reservation for a later execution. Limits cannot be updated, deleted or
replaced; changing a limit requires a separately reviewed budget/source version.

The bound applies to governed metric claims, not provider preparation connections,
all database activity, CPU/memory, billed costs or requests using independent
control stores. Hosts must still limit HTTP concurrency and preflight connections.
With read replicas, an inspection may lag; the final atomic primary-store claim
remains authoritative. A compatible Node control binding must preserve these
atomic-write semantics. Migration 0038 preserves existing claims and receipts,
counts prior unresolved claims, and creates no concurrency configuration rows.
Provision the explicit limits separately before enabling new execution.

### Active cancellation

The authenticated requester or source's named current owner can POST `cancel`
with only `{requestId}` (MCP: `postgresql_cancel`). Other tenant members, unrelated
owners and cross-tenant callers cannot cancel. This human authority also applies
to delegated Agent reads; Agent signatures do not grant a new cancellation tool.
The claim must exist. A new request is refused if a terminal outcome is already
known. Repeats return the existing intent only after current identity checks;
they do not change its actor, time, binding or receipt.

The atomic write binds tenant/request/intent and appends `pg-cancel-{intentId}`
with `outcome: pending`. The response is `status: cancellation-requested` and
`cancellationConfirmed: false`, never a delivery or terminal assertion. Human
inspection exposes `cancellation_requested_at`, Agent inspection exposes
`cancellationRequestedAt`, and both include the pending cancellation receipt ID.
Cancellation intent does not release concurrency, refund quota or rearm a contract.

The live original executor checks its own claim once per second while the metric
is in flight. Checks are serial with a one-second deadline; storage failure stops
this delivery monitor without inventing an outcome. A matching request triggers
at most one bounded (1.5-second) protocol CancelRequest on a separate connection
to the same bound host. Only the original dedicated connection's in-memory backend
key is used. No PID/key is accepted from a caller, persisted, returned or logged.
The channel uses `pg`'s protocol encoding and the same certificate/hostname checks,
waiting for verified TLS before sending; there is no plaintext fallback. The only
unencrypted exception remains the explicit loopback fixture. No administrative
database role or `pg_cancel_backend` privilege is needed.

Completion, local abort or deadline stops polling and closes the cancellation
channel. Late storage results cannot initiate delivery. A request can race a
successful query, so a confirmed success remains success. A delivered cancel can
also fail or arrive too late. Only the original metric ErrorResponse and same-
connection rollback acknowledgement can establish a supported failed outcome.
SQLSTATE 57014 does not identify the cancellation's cause; it is still `failed`,
not a user-attributed `cancelled` result.
[PostgreSQL cancellation protocol](https://www.postgresql.org/docs/17/protocol-flow.html#PROTOCOL-FLOW-CANCELING-REQUESTS).

Previously authorized cleanup intent remains deliverable after approval expiry,
retirement or membership revocation, but does not authorize another query. If the
original executor dies or the cancellation channel fails, this is pending evidence,
not proof that the provider stopped. There is no cross-process backend lookup,
PID-only cancellation, durable delivery retry or forced slot release. A stale read
replica can delay delivery; the host must provide a sufficiently fresh control
binding. Production enablement and migration remain separately gated.

### Bounded Agent execution

The operator enrolls the Agent's uncompressed P-256 public point in the existing
tenant-scoped `agent_verification_keys` registry. No self-enrollment endpoint or
private-key storage is provided. Disabling a key blocks new execution and Agent
inspection; re-enablement is not supported. A new key needs fresh consent.

1. The authenticated requester creates a read request, then calls `delegate` with
   `requestId`, `agentId`, `keyId`. Only that requester can consent. Consent has a
   database-clock ten-minute lifetime and cannot be attached after approval.
2. The resource's named owner inspects the request, including delegation terms,
   then calls `approve-agent-read` with the normal exact review fields plus
   `delegationId`, `agentId`, `keyId`. The audience is the configured HTTPS host,
   never client-selected. The ordinary `approve-read` cannot silently convert a
   delegated request to a session request. The contract records the original
   requester and actual Agent, with expiry no later than the consent.
3. The requester calls `agent-challenges` with `delegationId` and passes the
   canonical signing bytes and independently retained approved terms to the
   enrolled Agent through an authenticated channel. Execute and inspect have
   different purposes. Their signatures bind audience, tenant, requester, Agent,
   key, delegation nonce, request, release, source, contract, action/statement/
   definition/connection digests, role, quota scope, target and expiry.
4. `integrations/postgresql/agent.ts` supplies `signPostgresAgentCommand(challenge,
   expectedTerms, operation, privateKey)`. It requires exact canonical agreement
   with trusted terms before Web Crypto ECDSA/P-256/SHA-256 signing; returns
   `{delegationId, signature}` (64-byte signature encoded as 128 lowercase hex
   characters). Never populate trusted terms merely from an untrusted challenge.
   The private CryptoKey stays in the Agent host; do not serialize or log it.
5. Send that object to POST `/postgresql/{tenant}/agent-execute` or
   `/postgresql/{tenant}/agent-inspect`. These routes require no browser session
   and reject Cookie/Authorization headers and foreign Origin headers. When an
   Origin is present it must exactly match the host. HTTPS termination and host
   concurrency/rate limits remain mandatory.

The post-initialization `/postgresql/{tenant}/agent-mcp` hook accepts JSON-RPC
`tools/call` for `postgresql_agent_execute` or `postgresql_agent_inspect`, with the
same two signed arguments and the same service as REST. The host registers those
two tools and handles MCP initialization/discovery; this hook is not a complete
MCP server. Human consent/review/challenge/revocation commands remain available
through the session REST/MCP hooks, never through the Agent endpoint.

The signature is verified before provider resolution. After asynchronous signature
verification and PostgreSQL preparation, the atomic claim checks current key,
consent, membership, source, release, contract, stop and quota state again. A
signature does not create a reusable permission boolean. Concurrent replays have
at most one durable claim; session execution cannot consume Agent authority.
Pending receipts and consumed attempts are retained on unknown outcomes.

`revoke-delegation` is requester-only and idempotent, including after expiry or
key disablement. It blocks future claims, not an already-running query. Agent
inspection is read-only and permitted after retirement while its own consent,
key and requester remain eligible; after expiry/revocation the requester still
uses session `inspect`. Inspection never retries execution or returns stored
query values. Possession of a historical receipt grants no permission.

These are local host formats, not a new ODAP protocol revision or universal Agent
framework compatibility claim. The cryptographic implementation uses the standard
[Node Web Crypto API](https://nodejs.org/docs/latest-v24.x/api/webcrypto.html).

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

`executePostgresMetric(config, read, claim, signal, cancellationRequested?)` prepares the read, verifies
actual database/role/server/table/column metadata and only then calls `claim`.
The low-level callback receives frozen database, role, action, definition and statement
bindings. It **must atomically recheck current authority and reserve/record the
exact read in host storage**, with uniqueness and stale-authority protection.
Returning true is not itself an authorization mechanism. The connector has no
durable deduplication or authorization ledger of its own. The governed wrapper
supplies that ledger and a bounded claim deadline. A custom callback must also
have its own bounded deadline; arbitrary host callback execution is not cancellable.
The optional executor-only cancellation callback must read durable intent for this
exact claim. The governed wrapper supplies it; public callers cannot select it.

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
An actual metric ErrorResponse with severity `ERROR` and SQLSTATE `57014`
(`query_canceled`) or `42501` (`insufficient_privilege`), followed by a successful
ROLLBACK acknowledgement on the same connection with no local abort/deadline,
establishes the bounded `failed` result. The governed wrapper returns it only
after the matching immutable failed receipt is confirmed. It does not infer who
caused cancellation or return a `cancelled` user-intent outcome. Error text is not
parsed, returned or persisted. Other SQLSTATEs remain unsupported/uncertain.
[PostgreSQL error codes](https://www.postgresql.org/docs/17/errcodes-appendix.html).

Disconnects, local aborts, unknown errors, lost rollback acknowledgement and lost
terminal-write acknowledgement return `observation-required`. That is not
permission to refund, retry or infer a terminal outcome. An abort closes only this
call's connection. A cancellation request by itself does not prove cancellation;
this host does not expose an administrative backend-cancel endpoint.
[Cancellation acknowledgement semantics](https://www.postgresql.org/docs/17/libpq-cancel.html).

`postgresql_terminal_failures` binds the original tenant/request/intent/statement
digest and appends `pg-failed-{intentId}` using the existing EvidenceReceipt schema.
Earlier pending evidence remains intact. Conflicting success, mutation, deletion
and replacement are rejected. Terminal state and receipt are atomic; failed
receipt insertion rolls back the terminal row. A confirmed failed read still
consumes its attempt quota and contract, without a monetary refund claim.
Inspection returns the authoritative persisted state even if its write response
was lost. It never recovers or stores query values. Terminal recording is an
internal provider-observation API, not a REST/MCP command or caller assertion.

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
shared durable concurrency guard, retained capacity for unknown execution and
released capacity after confirmed completion, active cancellation of session and
Agent queries through human REST/MCP, cancellation TLS rejection without fallback,
and isolation from an unrelated live query, as well as the
governed host path, session and signed Agent REST/MCP, concurrency, requester
consent, owner/key/audience binding, revocation races, resolver substitution and
lost claim, observation or terminal acknowledgements. Eight isolated real-engine
cases use actual SIGKILL at claim acknowledgement, active query, success receipt
acknowledgement and failed receipt acknowledgement, for both session and Agent
execution. A fresh Node process then inspects the same durable ledger and proves
replay is refused before provider resolution. The killed child is an intentional
fault asserted by a normally completing test runner, not a passing crashed test.
Backend disappearance is fixture cleanup only, never a cancellation or success
proof. This validates host-process death, not storage/power loss, replica failover,
server restart or a generic distributed exactly-once guarantee.

SQLite also verifies upgrades retain prior contracts and receipts. These are
author engineering tests, not independent
signoff, formal scoring or a real pilot.

Still required for full acceptance: approved production catalog/auth/host setup and
schema rollout; open-ended policy/Agent grants where required; cross-process
reconciliation and cancellation delivery after executor death or delivery failure;
a reviewed monetary pricing/settlement model; broader
SQL/type/version coverage where required; independent review and an authorized
pilot. Do not enable the general adapter inspector by merely listing this host hook.
