# PostgreSQL governed host integration

`integrations/postgresql/index.ts` implements the restricted Node.js read connector.
`control.ts` connects it to persisted Gateway authority, and `gateway.ts` supplies
authenticated REST and post-initialization MCP command hooks. `server.ts` supplies
an optional bounded loopback HTTP listener. This is a **Node host
integration**, not a deployed Cloudflare Worker query endpoint or full PostgreSQL
SQL/type coverage. The offline inspector still refuses production Gateway dispatch.
Migrations `0035_postgresql_control.sql`, `0036_postgresql_agent_delegations.sql`,
`0037_postgresql_terminal_failures.sql`, `0038_postgresql_concurrency.sql` and
`0039_postgresql_cancellation.sql`
are opt-in and have not been applied to the production D1 database. Existing
production migration restrictions still apply.

## Supported slice

- Exact PostgreSQL 15.20, 16.16, 17.12 and 18.7 with `pg` 8.23.1.
  Other server builds fail closed; a major-version match alone is insufficient.
- One ordinary, non-inherited, non-partitioned table with active RLS.
- Released single-table `COUNT_ROWS` or `SUM` of `smallint`/`integer`/`bigint`/`numeric`.
- Equality filters for built-in `text`, `boolean`, `smallint`, `integer`, `bigint`,
  `numeric`, `uuid`, `date`, `time`, `timestamp`, `timestamptz` only.
  NULL matches NULL using `IS NOT DISTINCT FROM`; false is not NULL.
  Text and tenant parameters reject NUL and ill-formed Unicode before UTF-8 encoding.
- Tenant predicate is mandatory, uses a bound parameter and `C` collation,
  and supplements rather than replaces database RLS.
- Aggregates return exact decimal strings or null, never floating-point numbers.
  Empty COUNT is `"0"`; empty SUM is null. Nonfinite/over-256-character results
  fail closed. Arrays, JSON, floating-point, binary, domains, custom types, joins, arbitrary SQL,
  functions, views, foreign tables and pagination are not supported.

Successful connector results report the actual checked server version. The CI
matrix pins an official Linux amd64 image digest for every listed build and runs
the same complete synthetic engine suite, including RLS, exact types, configured
TLS/MCP, cancellation and eight process-crash cases. These observations do not
certify a managed service, fork, replica topology or untested patch release.
[PostgreSQL version policy](https://www.postgresql.org/support/versioning/).

Referenced columns must be ordinary or stored generated columns with the exact
built-in type. Virtual generated columns (introduced in PostgreSQL 18) are
computed on reads and are refused before claim, whether used as a measure, filter
or tenant discriminator. Unknown generation kinds also fail closed. Stored
generated values are verified with the same numeric result rules. Database owners,
generation expressions at write time and RLS policy functions remain trusted;
this is not a sandbox for administrator-controlled database behavior.
[Generated-column semantics](https://www.postgresql.org/docs/18/ddl-generated-columns.html).

The local `odap.postgresql-metric.v1` definition contains `tenantId`,
`sourceRevision`, `target`, `metricId`, `table`, `measure` and `filters`.
`table` binds `database`, `schema`, `name`, `tenantColumn`.
`measure` is `{aggregate:"COUNT_ROWS"}` or
`{aggregate:"SUM",column:"amount",type:"INT64"}` (also `INT16`, `INT32`, `DECIMAL`).
Each filter binds `{column,type}`. Identifiers are strict ASCII, at most 63 bytes.
The release digest and `odap.metric-read.v1` action are checked before connecting.
These are local engineering formats, not changes to the ODAP specification.

### Exact parameter types

The compiler and live metadata checks share one immutable built-in cast/OID
registry. A column with a domain, extension or merely compatible representation
does not inherit support. Parameter strings are bound, never interpolated.

| Definition type | Accepted non-null input |
| --- | --- |
| `INT16`, `INT32`, `INT64` | Safe JavaScript integer or canonical integer string within the exact signed width; no negative zero, leading zeros or exponents |
| `DECIMAL` | Plain decimal string, at most 128 characters; no exponent, NaN or Infinity |
| `BOOL`, `STRING` | Boolean, or well-formed Unicode text of at most 4096 UTF-16 code units without NUL |
| `UUID` | Lowercase canonical `8-4-4-4-12` hexadecimal string |
| `DATE` | Valid Gregorian `YYYY-MM-DD`, years 0001-9999 |
| `TIME` | `HH:MM:SS` with optional 1-6 fractional digits, no time zone |
| `TIMESTAMP` | Valid date, `T`, and the supported time; wall time without a zone |
| `TIMESTAMPTZ` | Valid timestamp plus `Z` or explicit offset through +/-14:00; `-00:00` (unknown offset) rejected |

Every supported type accepts null as a distinct value. Temporal inputs are not
converted to JavaScript `Date`: microseconds and explicit offsets reach PostgreSQL
unchanged. Locale formats, relative dates, year zero, 24:00, leap seconds, named
zones and extra precision fail closed. Timestamp equality uses PostgreSQL's
instant semantics; different offsets can denote the same instant. The action
and statement digests still bind the exact supplied representation.
[PostgreSQL date/time types](https://www.postgresql.org/docs/17/datatype-datetime.html),
[UUID type](https://www.postgresql.org/docs/17/datatype-uuid.html).

## Build and operate the host module

With the repository's locked dependencies and supported Node runtime:

```sh
npm ci
npm run postgresql:build
```

This emits CommonJS JavaScript and TypeScript declarations under
`dist/postgresql/`. It does not start a server, read environment credentials,
create a database or apply migrations. The standalone smoke test loads these
files in a new Node process, outside Vitest's TypeScript loader. Use the whole
output tree, not an individual file, and retain the pinned runtime dependencies.
The CI fixture runtime is Node 24.22.1; other runtime/provider combinations need
their own verification.

```js
const { createPostgresGateway } = require('./dist/postgresql/integrations/postgresql/gateway.js');
// env and resolve come from the authenticated host's trusted configuration.
const handler = createPostgresGateway({
  origin: 'https://your-approved-host.example', env, resolve,
  maxConcurrentExecutions: 8,
});
```

Mount this single long-lived handler in the host's existing Request/Response
bridge, or use the loopback listener below; do not instantiate a new handler per
request. No OAuth provider or public deployment is provisioned by this module.
Use an explicitly authorized deployment, trusted durable control binding and
secret resolver; the example is not authorization to configure production.

### Local durable control binding

`sqlite-control.ts` supplies `openPostgresSqliteControl(absolutePath)` for a trusted
Node host. Its `{db, close}` result implements the control-plane D1 interface;
it is **not** an adapter for querying SQLite business data. Pass `db` to the
host's existing `env.DB` binding and close it after in-flight handlers have drained.
Only Node **24.22.1** is accepted. The built-in `node:sqlite` API is release-candidate
software; other versions need separate compatibility verification.
[Node SQLite API](https://nodejs.org/download/release/v24.22.1/docs/api/sqlite.html).

The opener requires an existing, nonempty regular local file and the exact schema
fingerprint produced by migrations 0001-0039. Missing, symbolic-link or drifted
files fail closed. It never creates, migrates or seeds a control database, reads
credentials, or configures an administrator. Provisioning and schema upgrades
still require their own approval. No production database has been migrated.

Transactions use WAL, FULL synchronization and foreign keys, with a 250 ms busy
timeout and no automatic retries. Each operation/batch takes a short immediate
write transaction, including reads; the synchronous binding is for bounded
control queries, not analytic scans. Batches are atomic, limited to 100 owned
statements, 10,000 output rows and 8 MiB of output across the batch. SQL is bounded
to 65,536 characters, individual text/blob bindings to 1 MiB. Bound data stays
separate from SQL. Unsafe integer results, transaction/connection escape commands,
trailing statements, invalid result columns and limit failures roll back the
whole operation. Errors omit SQL, data and file paths.

Protect the parent directory and SQLite WAL/SHM sidecars with host filesystem
permissions; only trusted host code may use the binding. It is not an untrusted
SQL sandbox, high-availability service or network-filesystem deployment. Use a
SQLite-aware backup of the database and committed WAL, not a copy of the main file
while writers are active. Restart/recovery preserves unresolved claims and never
rearms them. Tests cover process termination, not power loss or damaged storage.

### Loopback HTTP service

```js
const { startPostgresHttpHost } = require('./dist/postgresql/integrations/postgresql/server.js');
// env already contains the approved control DB and authentication configuration.
// resolve is the trusted source registry's credential resolver, not request input.
const host = await startPostgresHttpHost({
  origin: 'https://your-approved-host.example', port: 8080,
  env, resolve, maxConcurrentExecutions: 8, maxRequests: 64,
  requestDeadlineMs: 30000,
});
// On operator-requested shutdown, stop acceptance and await in-flight work.
const state = await host.close(5000);
// Close the control store only when state.drained is true. If false, retain it
// until work settles and call close again; do not infer a query's terminal state.
```

Use this example inside an async entry point. The service always binds
`127.0.0.1`, never a public interface. A separately approved TLS reverse proxy must
preserve the configured canonical Host and authenticate clients through the
existing session/signed-Agent boundary. HTTPS origin is required even though this
internal hop is HTTP. Do not expose the loopback port through an unauthenticated
tunnel or reuse a main-site proxy without reviewing its routing and cookie scope.
Forwarded headers do not establish identity, origin or authorization. No proxy,
DNS, certificate, credentials or production route is created by this library.

HTTP/1.1 POST requests retain the `/postgresql/{tenant}/{command}` paths. The
listener rejects ambiguous duplicate headers, mismatched Host, compression,
trailers, expectation handshakes, upgrades and CONNECT. Request headers are bounded
to 16 KiB/128 fields, bodies to 64 KiB and responses to 1 MiB. Connections carry
one request; header/body receipt timeouts and a total request deadline are bounded.
Transport admission includes body receipt and handler work, separately from the
execution admission limit. Client disconnect or deadline signals cancellation to
the existing executor, without asserting provider cancellation or freeing durable
capacity. A timed-out handler retains its transport slot until it actually settles.
[Node HTTP lifecycle](https://nodejs.org/download/release/v24.22.1/docs/api/http.html).

`close(graceMs)` is idempotent, stops accepting work, waits for admitted work and
responses, then aborts overdue work and closes remaining sockets. `drained: false`
means host work remains; it is not permission to close its ledger, refund a claim
or retry a query. Even `drained: true` describes only host work, not a provider
terminal outcome. Existing post-initialization MCP hooks remain compatible; the
additional standard transport below supplies initialization/discovery. Neither
path provisions OAuth issuance or a public production deployment.

### Standard MCP transport

The loopback host additionally serves POST `/postgresql/{tenant}/mcp-stream` for
current browser-session identities and `/postgresql/{tenant}/agent-mcp-stream`
for scoped signed Agents. These use official `@modelcontextprotocol/server` 2.4.0
and are tested with `@modelcontextprotocol/client` 2.4.0 at protocol revisions
2025-11-25 and 2026-07-28. The former negotiates `initialize` and the latter
`server/discover`; both invoke the existing gateway service and share its execution
admission, approval, claim, receipt and replay rules. This is not a new ODAP revision.

Each request has a fresh SDK instance. No MCP session identifier is issued or
accepted, no persistent stream/resumption is offered, and GET/DELETE return 405.
The SDK handles protocol validation; the host preserves Accept, MCP-Protocol-Version,
Mcp-Method and Mcp-Name and refuses duplicate headers. The trusted TLS proxy must
preserve these and Host. Bodies are capped at 64 KiB, replies at 1 MiB; existing
host request deadlines and drain rules apply. No sampling, resources, prompts,
subscriptions or asynchronous task interface is registered.

The session endpoint requires the current verified cookie and exact Origin on
**every** protocol request, including discovery; initialization does not retain
authorization after membership/key/consent changes. This is the application's
existing session scheme, not an implementation of the MCP OAuth authorization
server profile. Production OAuth and initial administrator setup remain external
configuration, and general clients must support the selected authentication mode.

Agent initialization/discovery exposes only two static tool descriptions:
`postgresql_agent_execute` and `postgresql_agent_inspect`. No database lookup or
tenant existence claim is implied by discovery. Each call still requires its own
registered-key signature over the approved tenant, audience, delegation, contract
and operation; the endpoint rejects browser cookies and bearer identities.
It never exposes human review/approval tools to Agent callers.

For an already approved Agent delegation and configured HTTPS host:

```ts
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const client = new Client({ name: "approved-agent", version: "1.0.0" }, {
  supportedProtocolVersions: ["2026-07-28", "2025-11-25"],
  versionNegotiation: { mode: { pin: "2026-07-28" } },
});
await client.connect(new StreamableHTTPClientTransport(
  new URL(`/postgresql/${tenant}/agent-mcp-stream`, approvedHostOrigin),
));
try {
  const result = await client.callTool({ name: "postgresql_agent_execute",
    arguments: { delegationId, signature: executeSignature } });
  // A tool error or disconnect is not permission to issue a fresh execution.
  consumeResultWithoutAutomaticReplay(result);
} finally { await client.close(); }
```

Use `versionNegotiation: { mode: "legacy" }` for the tested 2025 initialization
flow. Signing remains the separately documented `signPostgresAgentCommand` flow;
no private key is sent. Disconnecting or sending a protocol cancellation notification
does not create the durable human-authorized cancellation command. Unknown reads
remain unresolved and consumed; inspect using the separately signed inspect proof.
Host draining waits for admitted provider/control work even if the SDK has already
closed the client exchange. These are socket/SDK engineering tests, not a real
external TLS-proxy deployment or a verified third-party Agent product integration.

Before enabling traffic, verify the exact engine/driver version, TLS trust,
read-only role/RLS, schema migration level and explicit source/budget/concurrency
rows. Apply migrations 0035-0039 in order only on an authorized target after
backup/restore validation. This release adds no migration. Never apply a schema
file merely to make a health check pass on an existing production database.

For upgrades, stop new execution admission at the host, allow in-flight operations
to finish within their existing deadlines, then preserve and inspect the durable
ledger. Deploy the pinned build and verify authenticated inspect before reopening
execution. Never replay unresolved reads during an upgrade. For rollback, restore
a previously verified code build compatible with the current schema; do not drop
append-only tables, delete receipts, refund attempts or reverse migrations to
match an older binary. If compatibility is unknown, leave execution disabled.
More restrictive code may refuse newer semantic types; use a reviewed compatible
release rather than silently coercing approved inputs.

## Configured service entry point

The Node 24.22.1 CLI assembles the existing SQLite control binding, fixed connection
resolver and loopback HTTP/MCP listener. Build first, then validate an operator-owned
configuration without contacting PostgreSQL, reading environment credentials or
opening the ledger:

```sh
npm run postgresql:build
npm run postgresql:check -- --config /absolute/path/to/host.json
```

`host.json` is strict UTF-8 JSON, at most 64 KiB. Every field below is required;
unknown fields, duplicate keys/scopes, comments and trailing commas are rejected.
Paths are absolute paths on the Node host. Windows paths must use JSON escaping
or forward slashes. This example names references only, not working credentials:

```json
{
  "schemaVersion": 1,
  "origin": "https://gateway.example.test",
  "port": 8789,
  "controlStorePath": "/srv/odap/control.db",
  "sessionSecretEnv": "ODAP_SESSION_SECRET",
  "maxRequests": 64,
  "maxConcurrentExecutions": 4,
  "requestDeadlineMs": 30000,
  "shutdownGraceMs": 5000,
  "connections": [{
    "tenantId": "tenant-a",
    "connectionRef": "approved-postgresql",
    "host": "database.example.test",
    "port": 5432,
    "database": "analytics",
    "role": "odap_reader",
    "passwordEnv": "ODAP_DATABASE_PASSWORD",
    "tls": {},
    "statementTimeoutMs": 5000,
    "lockTimeoutMs": 1000,
    "deadlineMs": 10000
  }]
}
```

`tls: {}` requires normal certificate and hostname verification with system trust.
For an explicitly approved private CA use `tls: { "caFile": "/absolute/ca.pem" }`;
the file must contain only CA certificates, not keys. Insecure fixture TLS, DSNs,
arbitrary driver options and caller-selected connections are not CLI options.
`passwordEnv` and `sessionSecretEnv` must be explicit, distinct `ODAP_...` names.
The session signing secret must contain at least 32 UTF-8 bytes. Resolve them
through the operator's approved secret delivery mechanism, never commit values
or pass them in command arguments. The process snapshots only those references;
ambient `PG*` variables are not fallback credentials. Restart to rotate secrets.

For an authorized database-password rotation, drain and stop the configured host,
rotate the password through the deployment's approved secret-management process,
then restart with the updated explicitly named secret. A running host keeps its
startup credential snapshot; mutating an environment object is not a reload API.
Do not substitute the role, endpoint, database, TLS trust or limits: those are
authority changes requiring the existing source review, not password rotation.
Existing PostgreSQL sessions are not assumed to be invalidated by changing a
password. Drain first; shutdown or restart never clears uncertain claims.

The isolated real-engine matrix exercises an intentionally stale host for both
session and signed-Agent reads: the replaced password fails before claim, consumes
no attempt, and leaks neither password. Restarting with the new password preserves
the connection binding and existing eligible approval, executes exactly once, and
still refuses replay. This tests password rotation on the pinned fixture builds,
not automatic secret-manager reload, session-cookie-key rotation, live production
rotation or a guarantee that every authentication failure occurs before claim.

After the separate authorization and provisioning prerequisites below are met:

```sh
npm run postgresql:serve -- --config /absolute/path/to/host.json
```

The listener binds only `127.0.0.1`. A trusted, separately configured TLS proxy
must preserve the exact configured Host and authorized Origin; forwarded headers
do not grant identity. There is no public-listener switch, demo mode, initial-admin
inference or login endpoint. Existing valid session authority and registered Agent
proofs are still mandatory. Configuration validation alone grants no authority.

The existing local control store must already have the reviewed schema and trusted
tenant/source/role/connection-digest, semantic release, permission and quota records.
`serve` never creates, seeds or migrates it. Connection digests must match the
approved registry; changing host, role, TLS or limits does not silently reauthorize
existing requests. `configuredPostgresConnections()` exposes the digest-only binding
list to trusted embedding code, never credentials or database results to a public
route. This CLI does not authorize a production migration or source enrollment.

On SIGINT/SIGTERM the host stops new admission and waits for the configured grace.
An elapsed grace can abort transport, but is not a terminal database proof. The
control store remains open until handlers finish; repeated drain checks do not
refund or replay uncertain requests. A process supervisor may force termination
after its own deadline, in which case normal stopped output is not guaranteed and
the persisted uncertain state remains authoritative. Cooperative signal handling is
tested in Linux CI; Windows forced process termination is not represented as a
successful graceful drain. Logs contain bounded lifecycle events, not config or
secret values. Supported SQL, types, versions and the remaining acceptance limits
below are unchanged.

## Host responsibilities

For governed use, call `executeGovernedPostgresRead(access, requestId, resolver,
signal)` or mount `createPostgresGateway({origin, env, resolve})` in an authenticated
Node host. `env` uses the existing session verifier and D1-compatible control-store
interface; Node hosts must provide a durable compatible binding. There is no
fallback to demo identity, CLI email, caller principal, or an Agent permission flag.
The host must bound total HTTP requests and supply TLS termination and OAuth session
issuance. The optional HTTP service above supplies standard MCP initialization;
the bare gateway hook still expects an initialized transport. Neither is an OAuth
provider. Bounded Agent execution uses the
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

### Local preparation admission

One gateway handler permits at most `maxConcurrentExecutions` active execution
operations (default 8, integer 1-1000). The bound includes authorization/preparation,
provider resolution and the eventual execution. All tenants, human/Agent calls
and REST/MCP execution hooks share this local capacity. There is no wait queue or
automatic retry. REST and Agent overload responses use HTTP 429 with
`postgresql_host_busy`; session MCP returns a tool error stating that no execution
was admitted. Refusal does not call the execution service or consume a contract.

Inspect, cancellation, stop, revocation and other control commands do not acquire
an execution slot. Existing authentication and authorization checks still apply.
The slot is released in `finally` after the governed operation settles, including
errors; a local abort alone does not decrement the counter while work remains.
This is not a global database connection pool, rate limit or durable claim limit.
Multiple handlers/processes have independent local counters; the shared durable
limit below remains authoritative for metric claims. Low-level API users must
provide their own admission bound. Hosts must additionally bound incoming bodies,
slow clients and control-store traffic, and avoid allocating provider connections
inside a configuration resolver.

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
this delivery monitor without inventing an outcome. A matching request opens a
bounded (1.5-second) cancellation channel to the same bound host. A channel failure
before attempting the CancelRequest write may be retried after one second, with
at most three serial channels for this query. Each retry rechecks durable intent
and repeats TLS validation. Once a write is attempted, including a throwing write,
delivery is uncertain and is not retried. No query submission is replayed.
Only the original dedicated connection's in-memory backend
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
PID-only cancellation, restart-surviving delivery retry or forced slot release. A stale read
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
two tools and handles MCP initialization/discovery, or uses the standard transport
above; this bare hook is not a complete MCP server. Human consent/review/challenge/revocation commands remain available
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

## Read-only evidence export

Authenticated human requests with a structurally valid action and a missing
tenant-local semantic release now append an existing-format denied receipt before
refusing the request. Each refused attempt has a server-assigned opaque ID, the
current principal, the `postgresql-session` human marker and the action digest;
parameter values are not persisted. The shared audit trigger atomically rechecks
membership and release absence, and rolls back if the receipt cannot be appended.
No contract, claim, resource reservation or provider access is created.
Bounded strings, booleans, null and safe integer numbers retain their exact action
digest, including the distinction between `false`, null, `0` and `"0"`. Negative
zero, fractional/nonfinite numbers and unsafe integers are refused before audit
persistence, consistent with the supported numeric parameter encodings.

External REST/MCP errors remain identical for missing and unavailable releases;
receipt IDs are not exposed as an existence probe. A concurrent publication or a
failed/lost audit acknowledgement still refuses the request without automatic
execution or retry. This is a bounded missing-release audit path, not a claim that
all malformed, unauthenticated or other policy refusals have durable receipts.
The claim export below does not include these pre-approval attempts; they remain
in the existing tenant-scoped receipt/audit storage.

The source's named, currently active owner can call the human REST command
`export-evidence` with `{ "requestId": "..." }` or the standard MCP tool
`postgresql_export_evidence`. The response is `{ "json": "...", "digest": "sha256:..." }`.
Requesters, reviewers, other owners and Agents cannot export through this command.
Historical export remains available after source retirement; it does not restore
execution authority. No database connection or credential resolver is invoked.

The bounded canonical snapshot includes the semantic definition, approved action,
source relation/role and connection digest, contract, original claim, optional
observations/failure/cancellation request and their original receipts. It excludes
credentials, endpoints, backend cancellation keys and query results. Definitions
and action filters may still contain sensitive business metadata: treat the bundle
as tenant-confidential and do not publish it by default. It is a selected-record
snapshot, not a complete audit export or a ledger backup.

Build and verify a detached export with an independently retained digest:

```sh
npm run evidence:build
npm run evidence:verify-postgresql -- bundle.json TENANT REQUEST INTENT expected.sha256
```

The `expected.sha256` file contains the independently retained `sha256:` digest.
The CLI accepts at most 256 KiB of canonical UTF-8 JSON and requires the expected
tenant/request/intent and checksum. Exit 0 means the selected records are internally
consistent and match the supplied checksum; exit 1 rejects invalid input and exit 2
reports invalid usage. A checksum from the same untrusted bundle cannot establish
issuer identity. The verifier recompiles the metric bindings and checks receipt
identity, outcome and chronology. It does not contact PostgreSQL, validate an Agent
signature, establish issuer identity, certify provider truth or grant execution
authority. Those limitations are explicit false flags in its output.

Unknown outcomes remain `observation-required`; money remains `unpriced`. A
cancellation intent and even SQLSTATE `57014` do not prove that a particular caller
caused cancellation. Export and verification never release capacity, refund quota,
replay the query or make a formal scoring/independent-signoff claim. The profile
`odap.gateway.local.postgresql-read-evidence.v1` is a local engineering format,
not a protocol change.

## Verification and remaining work

`npm test` runs pure compiler tests. `npm run test:postgresql` requires a new,
disposable supported PostgreSQL fixture at `127.0.0.1:55432`, database
`odap_pg_fixture`, plus `ODAP_POSTGRES_FIXTURE=isolated-synthetic-only`.
`ODAP_POSTGRES_VERSION` selects one exact listed build and defaults to `17.12`;
the observed `server_version_num` must match. An unknown selector or a mismatched
server is a failure, not a compatibility inference.
Do not run it against an existing database: setup creates roles/schema/tables and
intentionally fails if they already exist. The CI `postgresql-integration` job
pins each official Linux amd64 image digest and publishes separate real test and server
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
and isolation from an unrelated live query, as well as
bounded retry after a dropped pre-TLS cancellation channel for both session and
Agent queries. The real proxy test observes retained capacity before delivery,
exactly one query claim and release only after the original failure receipt. Other
cases cover the governed host path, session and signed Agent REST/MCP, concurrency, requester
consent, owner/key/audience binding, revocation races, resolver substitution and
lost claim, observation or terminal acknowledgements. Socket tests cover HTTP
boundaries, admission retention and bounded draining; real-engine tests also send
session/Agent REST/MCP reads through the listener and disconnect an active client
without replaying or refunding its uncertain read. These cases are complemented
by official SDK session/Agent calls at both tested protocol
revisions, refusing replay after successful execution and retaining uncertainty
after an active standard-client disconnect. Eight isolated real-engine
cases use actual SIGKILL at claim acknowledgement, active query, success receipt
acknowledgement and failed receipt acknowledgement, for both session and Agent
execution. A fresh Node process then inspects the same durable ledger and proves
replay is refused before provider resolution. The killed child is an intentional
fault asserted by a normally completing test runner, not a passing crashed test.
Backend disappearance is fixture cleanup only, never a cancellation or success
proof. This validates host-process death, not storage/power loss, replica failover,
server restart or a generic distributed exactly-once guarantee.

The configured entry point is additionally exercised through real PostgreSQL/TLS
and the official MCP client for session/Agent calls, with configured tenant,
connection-reference and role substitution rejected before a claim. Compiled CLI
tests cover validation without secrets/storage, refusal to create a missing ledger
and a normally exiting Linux SIGTERM drain. These do not configure a production host.

SQLite also verifies upgrades retain prior contracts and receipts. These are
author engineering tests, not independent
signoff, formal scoring or a real pilot.

Still required for full acceptance: approved production catalog/auth/host setup and
schema rollout; open-ended policy/Agent grants where required; cross-process
reconciliation and cancellation delivery after executor death or delivery failure;
a reviewed monetary pricing/settlement model; broader
SQL/type/version coverage where required; independent review and an authorized
pilot. Do not enable the general adapter inspector by merely listing this host hook.
