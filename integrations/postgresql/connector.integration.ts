import { afterAll, beforeAll, expect, it } from "vitest";
import { Client } from "pg";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { executePostgresMetric, type PostgresClaim, type PostgresHostConfig } from "./index";
import { postgresDefinition as d, postgresRead, postgresSource, postgresBarrier } from "../../tests/fixtures/postgresql";
import { executeGovernedPostgresRead, postgresAgentOperation, postgresConnectionDigest } from "./control";
import { jobTransactionalDatabase } from "../../tests/fixtures/job-sqlite";
import { initializePostgresLocalFixture } from "../../tests/fixtures/postgresql-local-store";
import { openPostgresSqliteControl, POSTGRES_CONTROL_SCHEMA_DIGEST } from "./sqlite-control";
import { approvePostgresFixture, pgAccess, pgAction, publishPostgresFixture, seedPostgresControl } from "../../tests/fixtures/postgresql-control";
import { inspectPostgresRead } from "../../lib/postgresql-control";
import type { D1Database } from "../../lib/d1";
import { createPostgresGateway } from "./gateway";
import { SESSION_COOKIE, signAuthPayload } from "../../lib/auth";
import { approvePostgresAgentFixture, pgAgentOrigin } from "../../tests/fixtures/postgresql-agent";
import { revokePostgresDelegation } from "../../lib/postgresql-agent";
import { postgresCrashCases } from "../../tests/fixtures/postgresql-crash-cases";
import { sendPostgresCancellation, type PostgresBackendKey } from "./cancellation";
import { startPostgresHttpHost } from "./server";
import { startConfiguredPostgresHost } from "./host";
import { POSTGRES_SERVER_VERSIONS, postgresServerVersion } from "./compatibility";
import { postgresHttpRequest } from "../../tests/fixtures/postgresql-http";
import { connectPostgresMcpFixture } from "../../tests/fixtures/postgresql-mcp";

// Fixed disposable fixture only: never accept a business endpoint or credentials.
const fixtureVersion = process.env.ODAP_POSTGRES_VERSION ?? "17.12";
const fixtureVersionNumber = Object.entries(POSTGRES_SERVER_VERSIONS).find(([, label]) => label === fixtureVersion)?.[0];
const config: PostgresHostConfig = { host: "127.0.0.1", port: 55432, database: "odap_pg_fixture",
  user: "reader_a", password: "synthetic-fixture-only", tls: { insecureLoopback: true },
  statementTimeoutMs: 1000, lockTimeoutMs: 200, deadlineMs: 5000 };
const admin = new Client({ host: config.host, port: config.port, database: config.database,
  user: "postgres", password: "synthetic-ci-only", ssl: false, connectionTimeoutMillis: 5000 });

beforeAll(async () => {
  if (process.env.ODAP_POSTGRES_FIXTURE !== "isolated-synthetic-only") throw new Error("Disposable fixture opt-in required");
  if (!fixtureVersionNumber) throw new Error("Unsupported fixture version");
  await admin.connect();
  const version = (await admin.query("SHOW server_version_num")).rows[0].server_version_num;
  const driverVersion: string = createRequire(import.meta.url)("pg/package.json").version;
  expect(version).toBe(fixtureVersionNumber);
  expect(postgresServerVersion(version)).toBe(fixtureVersion);
  expect(driverVersion).toBe("8.23.1");
  // CREATE without IF NOT EXISTS prevents accidental reuse of an existing fixture.
  await admin.query(`CREATE ROLE reader_a LOGIN PASSWORD 'synthetic-fixture-only' NOSUPERUSER NOBYPASSRLS;
    CREATE ROLE reader_b LOGIN PASSWORD 'synthetic-fixture-only' NOSUPERUSER NOBYPASSRLS;
    CREATE SCHEMA metrics;
    CREATE TABLE metrics.orders (tenant_id text NOT NULL, amount bigint, price numeric, active boolean, label text);
    INSERT INTO metrics.orders VALUES
      ('tenant-a',9007199254740993,12345678901234567890.123456789,false,'normal'),
      ('tenant-a',7,0.000000001,false,'second'), ('tenant-a',NULL,NULL,NULL,NULL),
      ('tenant-b',666,99.99,false,'normal');
    ALTER TABLE metrics.orders ENABLE ROW LEVEL SECURITY;
    ALTER TABLE metrics.orders FORCE ROW LEVEL SECURITY;
    CREATE POLICY tenant_access ON metrics.orders TO reader_a,reader_b USING
      (tenant_id = CASE current_user WHEN 'reader_a' THEN 'tenant-a' WHEN 'reader_b' THEN 'tenant-b' END);
    GRANT USAGE ON SCHEMA metrics TO reader_a,reader_b;
    GRANT SELECT ON metrics.orders TO reader_a,reader_b;
    CREATE TABLE metrics.unprotected (LIKE metrics.orders);
    GRANT SELECT ON metrics.unprotected TO reader_a;
    CREATE VIEW metrics.orders_view AS SELECT * FROM metrics.orders;
    GRANT SELECT ON metrics.orders_view TO reader_a;
    CREATE FUNCTION metrics.slow() RETURNS boolean LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.2); RETURN true; END $$;
    CREATE TABLE metrics.slow_orders (LIKE metrics.orders);
    INSERT INTO metrics.slow_orders SELECT * FROM metrics.orders;
    ALTER TABLE metrics.slow_orders ENABLE ROW LEVEL SECURITY;
    CREATE POLICY slow_access ON metrics.slow_orders TO reader_a USING (metrics.slow());
    GRANT SELECT ON metrics.slow_orders TO reader_a;
    CREATE FUNCTION metrics.crash_slow() RETURNS boolean LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(2); RETURN true; END $$;
    CREATE TABLE metrics.crash_orders (LIKE metrics.orders);
    INSERT INTO metrics.crash_orders SELECT * FROM metrics.orders;
    ALTER TABLE metrics.crash_orders ENABLE ROW LEVEL SECURITY;
    CREATE POLICY crash_access ON metrics.crash_orders TO reader_a USING (metrics.crash_slow());
    GRANT SELECT ON metrics.crash_orders TO reader_a;
    CREATE DOMAIN metrics.custom_number AS bigint;
    CREATE TABLE metrics.domain_orders (tenant_id text, amount metrics.custom_number);
    ALTER TABLE metrics.domain_orders ENABLE ROW LEVEL SECURITY;
    CREATE POLICY domain_access ON metrics.domain_orders TO reader_a USING (true);
    GRANT SELECT ON metrics.domain_orders TO reader_a;`);
  await admin.query(`CREATE TABLE metrics.typed_orders (tenant_id text, small_value smallint, integer_value integer,
      day_value date, time_value time, local_value timestamp, instant_value timestamptz, uuid_value uuid);
    INSERT INTO metrics.typed_orders VALUES
      ('tenant-a',32767,2147483647,'2024-02-29','12:30:45.123456','2024-11-03T01:30:00.123456',
        '2024-11-03T01:30:00.123456-04:00','00000000-0000-0000-0000-000000000001'),
      ('tenant-a',-32768,-2147483648,'2000-02-29','12:30:45.123457','2024-11-03T01:30:00.123457',
        '2024-11-03T01:30:00.123456-05:00','00000000-0000-0000-0000-000000000002'),
      ('tenant-a',NULL,NULL,NULL,NULL,NULL,NULL,NULL),
      ('tenant-b',32767,2147483647,'2024-02-29','12:30:45.123456','2024-11-03T01:30:00.123456',
        '2024-11-03T01:30:00.123456-04:00','00000000-0000-0000-0000-000000000001');
    ALTER TABLE metrics.typed_orders ENABLE ROW LEVEL SECURITY;
    ALTER TABLE metrics.typed_orders FORCE ROW LEVEL SECURITY;
    CREATE POLICY typed_access ON metrics.typed_orders TO reader_a,reader_b USING
      (tenant_id = CASE current_user WHEN 'reader_a' THEN 'tenant-a' WHEN 'reader_b' THEN 'tenant-b' END);
    GRANT SELECT ON metrics.typed_orders TO reader_a,reader_b;`);
  writeFileSync("postgresql-environment.json", JSON.stringify({ serverVersion: postgresServerVersion(version), serverVersionNum: version,
    driver: "pg", driverVersion, syntheticDataOnly: true, transport: "isolated-loopback-without-TLS",
    productionVerified: false, gatewayDispatchIntegrated: true, transportScope: "Node host, not deployed Worker",
    tlsFixtureRequired: true, signedAgentDelegation: true, terminalCodes: ["57014", "42501"],
    hostCrashFixture: "SIGKILL-execute/fresh-process-recovery", durableConcurrency: true, activeCancellation: true, configuredHost: true,
    controlStore: "node:sqlite", controlSchemaDigest: POSTGRES_CONTROL_SCHEMA_DIGEST, nodeVersion: process.versions.node,
    nodeHttpHost: "loopback-only-trusted-TLS-proxy-required",
    mcpSdkVersion: "2.4.0", mcpProtocols: ["2025-11-25", "2026-07-28"], mcpTransport: "stateless-official-client",
    scalarTypes: ["INT16", "INT32", "INT64", "DECIMAL", "BOOL", "STRING", "UUID", "DATE", "TIME", "TIMESTAMP", "TIMESTAMPTZ"],
    resourceUnit: "unresolved-read-claim", budgetUnit: "read-attempt", monetaryCost: "unpriced" }, null, 2) + "\n");
});
afterAll(async () => { await admin.end(); });

async function governedFixture(test: (db: D1Database, file: string) => Promise<void>, c = config,
  definition: Omit<typeof d, "measure"> & { measure: Record<string, unknown> } = d,
  concurrency = 2, action: unknown = pgAction) {
  const directory = await mkdtemp(join(tmpdir(), "odap-pg-governed-"));
  let store: ReturnType<typeof openPostgresSqliteControl> | undefined;
  try {
    const file = join(directory, "ledger.db");
    initializePostgresLocalFixture(file);
    store = openPostgresSqliteControl(file);
    const db = store.db;
    await seedPostgresControl(db, await postgresConnectionDigest("tenant-a", c), 2, { ...postgresSource, table: definition.table.name }, concurrency);
    await publishPostgresFixture(db, definition); await approvePostgresFixture(db, "request", action);
    await test(db, file);
  } finally { store?.close(); await rm(directory, { recursive: true, force: true }); }
}

postgresCrashCases(governedFixture, admin, config);

it("enforces stored and virtual generated-column boundaries on the selected server", async () => {
  await admin.query(`CREATE TABLE metrics.generated_orders (
    tenant_id text NOT NULL, amount bigint, derived bigint GENERATED ALWAYS AS (amount * 2) STORED);
    INSERT INTO metrics.generated_orders (tenant_id,amount) VALUES ('tenant-a',1),('tenant-a',2),('tenant-b',100);
    ALTER TABLE metrics.generated_orders ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_access ON metrics.generated_orders TO reader_a USING (tenant_id='tenant-a');
    GRANT SELECT ON metrics.generated_orders TO reader_a`);
  const stored = await postgresRead({ ...d, table: { ...d.table, name: "generated_orders" },
    measure: { aggregate: "SUM", column: "derived", type: "INT64" } });
  stored.source.table = "generated_orders"; let claims = 0;
  expect(await executePostgresMetric(config, stored, async () => { claims++; return true; }))
    .toMatchObject({ outcome: "succeeded", value: "6", serverVersion: fixtureVersion });
  expect(claims).toBe(1);
  if (fixtureVersion !== "18.7") return;

  await admin.query(`CREATE TABLE metrics.virtual_orders (
    tenant_id text NOT NULL, amount bigint,
    derived bigint GENERATED ALWAYS AS (amount * 2) VIRTUAL,
    virtual_tenant text GENERATED ALWAYS AS (tenant_id) VIRTUAL);
    INSERT INTO metrics.virtual_orders (tenant_id,amount) VALUES ('tenant-a',1),('tenant-b',100);
    ALTER TABLE metrics.virtual_orders ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_access ON metrics.virtual_orders TO reader_a USING (tenant_id='tenant-a');
    GRANT SELECT ON metrics.virtual_orders TO reader_a`);
  for (const use of ["measure", "filter", "tenant"]) {
    const definition = { ...d, table: { ...d.table, name: "virtual_orders",
      tenantColumn: use === "tenant" ? "virtual_tenant" : "tenant_id" },
      measure: use === "measure" ? { aggregate: "SUM", column: "derived", type: "INT64" } : d.measure,
      filters: use === "filter" ? { n: { column: "derived", type: "INT64" } } : {} };
    const read = await postgresRead(definition, use === "filter" ? { n: "2" } : {});
    read.source.table = "virtual_orders"; read.source.tenantColumn = definition.table.tenantColumn;
    let virtualClaims = 0;
    expect(await executePostgresMetric(config, read, async () => { virtualClaims++; return true; }))
      .toMatchObject({ outcome: "not-submitted", claim: "not-attempted", reason: "preflight-rejected" });
    expect(virtualClaims).toBe(0);
  }
});

async function configuredFixture(file: string, changes: Record<string, unknown> = {}) {
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address(); if (!address || typeof address === "string") throw new Error("Fixture port unavailable");
  await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  const path = join(dirname(file), "host.json");
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, origin: pgAgentOrigin, port: address.port, controlStorePath: file,
    sessionSecretEnv: "ODAP_SESSION_SECRET", maxRequests: 8, maxConcurrentExecutions: 2, requestDeadlineMs: 10000,
    shutdownGraceMs: 1000, connections: [{ tenantId: "tenant-a", connectionRef: "fixture", host: config.host, port: config.port,
      database: config.database, role: config.user, passwordEnv: "ODAP_DATABASE_PASSWORD",
      tls: { caFile: resolve(".tmp/postgresql-tls/server.crt") }, statementTimeoutMs: config.statementTimeoutMs,
      lockTimeoutMs: config.lockTimeoutMs, deadlineMs: config.deadlineMs, ...changes }] }));
  return startConfiguredPostgresHost(path, { ODAP_SESSION_SECRET: "synthetic-configured-session-secret-over-32-bytes",
    ODAP_DATABASE_PASSWORD: "synthetic-fixture-only" });
}

it.each([false, true])("executes through the configured TLS host and official MCP client (Agent=%s)", async agent => {
  const c = { ...config, tls: { ca: readFileSync(".tmp/postgresql-tls/server.crt", "utf8") } };
  await governedFixture(async (db, file) => {
    const a = agent ? await approvePostgresAgentFixture(db) : undefined;
    const host = await configuredFixture(file);
    let connection: Awaited<ReturnType<typeof connectPostgresMcpFixture>> | undefined;
    try {
      expect(host.bindings).toEqual([{ tenantId: "tenant-a", connectionRef: "fixture",
        connectionDigest: await postgresConnectionDigest("tenant-a", c) }]);
      const headers: Record<string, string> = { Origin: pgAgentOrigin };
      if (!a) headers.Cookie = SESSION_COOKIE + "=" + await signAuthPayload({ provider: "google", providerId: "reader",
        email: "synthetic@example.test", name: "Synthetic", expiresAt: Date.now() + 600000 },
      "synthetic-configured-session-secret-over-32-bytes");
      connection = await connectPostgresMcpFixture(host.address, pgAgentOrigin,
        `/postgresql/tenant-a/${agent ? "agent-mcp-stream" : "mcp-stream"}`, headers, true);
      const arguments_ = a ? { delegationId: a.delegationId, signature: a.signature } : { requestId: "request" };
      const name = agent ? "postgresql_agent_execute" : "postgresql_execute";
      const result = await connection.client.callTool({ name, arguments: arguments_ });
      expect(result.isError).toBe(false);
      expect(JSON.parse((result.content as { text: string }[])[0].text)).toMatchObject({ outcome: "succeeded", value: "3" });
      expect(await inspectPostgresRead(pgAccess(db), a ? "agent-request" : "request")).toMatchObject({ state: "succeeded", used_attempts: 1 });
      expect((await connection.client.callTool({ name, arguments: arguments_ })).isError).toBe(true);
    } finally { await connection?.close(); expect(await host.close()).toEqual({ drained: true }); }
  }, c);
});

it.each([{ tenantId: "tenant-b" }, { connectionRef: "other" }, { role: "reader_b" }])(
  "refuses a configured authority mismatch before a real database claim (%j)", async changes => {
  const c = { ...config, tls: { ca: readFileSync(".tmp/postgresql-tls/server.crt", "utf8") } };
  await governedFixture(async (db, file) => {
    const host = await configuredFixture(file, changes);
    try {
      const cookie = SESSION_COOKIE + "=" + await signAuthPayload({ provider: "google", providerId: "reader",
        email: "synthetic@example.test", name: "Synthetic", expiresAt: Date.now() + 600000 },
      "synthetic-configured-session-secret-over-32-bytes");
      const reply = await postgresHttpRequest(host.address, "/postgresql/tenant-a/execute", { requestId: "request" },
        { Host: "gateway.test", Origin: pgAgentOrigin, Cookie: cookie }).result;
      expect(reply.status).toBe(409);
      expect(await inspectPostgresRead(pgAccess(db), "request")).toMatchObject({ used_attempts: 0, intent_id: null });
      expect((await admin.query("SELECT pid FROM pg_stat_activity WHERE application_name='odap-postgresql-preview'")).rows).toEqual([]);
    } finally { expect(await host.close()).toEqual({ drained: true }); }
  }, c);
});

it.each([{ agent: false, modern: false }, { agent: true, modern: false }, { agent: false, modern: true }, { agent: true, modern: true }])(
  "executes a real governed read with the official MCP client (Agent=$agent modern=$modern)", async ({ agent, modern }) => {
  await governedFixture(async db => {
    const secret = "synthetic-mcp-integration-only", a = agent ? await approvePostgresAgentFixture(db) : undefined;
    const host = await startPostgresHttpHost({ origin: pgAgentOrigin, port: 0, env: { DB: db, AUTH_COOKIE_SECRET: secret }, resolve: async () => config });
    let connection: Awaited<ReturnType<typeof connectPostgresMcpFixture>> | undefined;
    try {
      const headers: Record<string, string> = { Origin: pgAgentOrigin };
      if (!a) headers.Cookie = SESSION_COOKIE + "=" + await signAuthPayload({ provider: "google", providerId: "reader",
        email: "synthetic@example.test", name: "Synthetic", expiresAt: Date.now() + 600000 }, secret);
      connection = await connectPostgresMcpFixture(host.address, pgAgentOrigin,
        `/postgresql/tenant-a/${agent ? "agent-mcp-stream" : "mcp-stream"}`, headers, modern);
      const result = await connection.client.callTool({ name: agent ? "postgresql_agent_execute" : "postgresql_execute",
        arguments: a ? { delegationId: a.delegationId, signature: a.signature } : { requestId: "request" } });
      expect(result.isError).toBe(false);
      const text = result.content as { type: string; text: string }[];
      expect(JSON.parse(text[0].text)).toMatchObject({ outcome: "succeeded", value: "3" });
      expect(await inspectPostgresRead(pgAccess(db), a ? "agent-request" : "request")).toMatchObject({ state: "succeeded", used_attempts: 1 });
      const replay = await connection.client.callTool({ name: agent ? "postgresql_agent_execute" : "postgresql_execute",
        arguments: a ? { delegationId: a.delegationId, signature: a.signature } : { requestId: "request" } });
      expect(replay.isError).toBe(true);
    } finally { await connection?.close(); expect(await host.close()).toEqual({ drained: true }); }
  });
});

it("preserves real-query uncertainty after official MCP client disconnect", async () => {
  const c = { ...config, statementTimeoutMs: 3000, deadlineMs: 6000 };
  await governedFixture(async db => {
    const secret = "synthetic-mcp-disconnect-only";
    const cookie = SESSION_COOKIE + "=" + await signAuthPayload({ provider: "google", providerId: "reader",
      email: "synthetic@example.test", name: "Synthetic", expiresAt: Date.now() + 600000 }, secret);
    const host = await startPostgresHttpHost({ origin: pgAgentOrigin, port: 0, env: { DB: db, AUTH_COOKIE_SECRET: secret }, resolve: async () => c });
    const connection = await connectPostgresMcpFixture(host.address, pgAgentOrigin, "/postgresql/tenant-a/mcp-stream", { Origin: pgAgentOrigin, Cookie: cookie }, true);
    const pending = connection.client.callTool({ name: "postgresql_execute", arguments: { requestId: "request" } }).then(() => "response", () => "disconnected");
    try {
      await expect.poll(async () => (await admin.query(`SELECT pid FROM pg_stat_activity WHERE datname='odap_pg_fixture'
        AND usename='reader_a' AND application_name='odap-postgresql-preview' AND state='active'
        AND wait_event='PgSleep' AND query LIKE '%AS metric_value FROM ONLY%crash_orders%'`)).rows.length,
      { timeout: 4000, interval: 10 }).toBe(1);
      await connection.close(); expect(await pending).toBe("disconnected");
      expect(await host.close()).toEqual({ drained: true });
      expect(await inspectPostgresRead(pgAccess(db), "request")).toMatchObject({ state: "observation-required", used_attempts: 1, unresolved_claims: 1 });
      let calls = 0;
      await expect(executeGovernedPostgresRead(pgAccess(db), "request", async () => { calls++; return c; })).rejects.toThrow();
      expect(calls).toBe(0);
      await expect.poll(async () => (await admin.query("SELECT pid FROM pg_stat_activity WHERE application_name='odap-postgresql-preview'")).rows.length,
        { timeout: 5000, interval: 20 }).toBe(0);
    } finally { await connection.close(); await pending; await host.close(); }
  }, c, { ...d, table: { ...d.table, name: "crash_orders" } }, 1);
});

it.each([{ agent: false, mcp: false }, { agent: false, mcp: true }, { agent: true, mcp: false }, { agent: true, mcp: true }])(
  "serves a governed real PostgreSQL read through the loopback listener (Agent=$agent MCP=$mcp)", async ({ agent, mcp }) => {
  await governedFixture(async db => {
    const secret = "synthetic-http-integration-only", a = agent ? await approvePostgresAgentFixture(db) : undefined;
    const host = await startPostgresHttpHost({ origin: pgAgentOrigin, port: 0,
      env: { DB: db, AUTH_COOKIE_SECRET: secret }, resolve: async () => config });
    try {
      const headers: Record<string, string> = { Host: "gateway.test", Origin: pgAgentOrigin };
      if (!a) headers.Cookie = SESSION_COOKIE + "=" + await signAuthPayload({ provider: "google", providerId: "reader",
        email: "synthetic@example.test", name: "Synthetic", expiresAt: Date.now() + 600000 }, secret);
      const args = a ? { delegationId: a.delegationId, signature: a.signature } : { requestId: "request" };
      const path = `/postgresql/tenant-a/${a ? "agent-" : ""}${mcp ? "mcp" : "execute"}`;
      const reply = await postgresHttpRequest(host.address, path, mcp ? { jsonrpc: "2.0", id: "network", method: "tools/call",
        params: { name: a ? "postgresql_agent_execute" : "postgresql_execute", arguments: args } } : args, headers).result;
      expect(reply.status).toBe(200); const data = JSON.parse(reply.data);
      expect(mcp ? JSON.parse(data.result.content[0].text) : data.result).toMatchObject({ outcome: "succeeded", value: "3" });
      expect(await inspectPostgresRead(pgAccess(db), a ? "agent-request" : "request")).toMatchObject({ state: "succeeded", used_attempts: 1 });
    } finally { expect(await host.close()).toEqual({ drained: true }); }
  });
});

it("keeps a real read uncertain after HTTP client disconnect rather than replaying or refunding", async () => {
  const c = { ...config, statementTimeoutMs: 3000, deadlineMs: 6000 };
  await governedFixture(async db => {
    const secret = "synthetic-http-disconnect-only";
    const cookie = SESSION_COOKIE + "=" + await signAuthPayload({ provider: "google", providerId: "reader",
      email: "synthetic@example.test", name: "Synthetic", expiresAt: Date.now() + 600000 }, secret);
    const host = await startPostgresHttpHost({ origin: pgAgentOrigin, port: 0,
      env: { DB: db, AUTH_COOKIE_SECRET: secret }, resolve: async () => c });
    const pending = postgresHttpRequest(host.address, "/postgresql/tenant-a/execute", { requestId: "request" },
      { Host: "gateway.test", Origin: pgAgentOrigin, Cookie: cookie });
    const settled = pending.result.then(() => "response", () => "disconnected");
    try {
      await expect.poll(async () => (await admin.query(`SELECT pid FROM pg_stat_activity WHERE datname='odap_pg_fixture'
        AND usename='reader_a' AND application_name='odap-postgresql-preview' AND state='active'
        AND wait_event='PgSleep' AND query LIKE '%AS metric_value FROM ONLY%crash_orders%'`)).rows.length,
      { timeout: 4000, interval: 10 }).toBe(1);
      pending.destroy(); expect(await settled).toBe("disconnected");
      expect(await host.close()).toEqual({ drained: true });
      expect(await inspectPostgresRead(pgAccess(db), "request")).toMatchObject({ state: "observation-required", used_attempts: 1, unresolved_claims: 1 });
      let calls = 0;
      await expect(executeGovernedPostgresRead(pgAccess(db), "request", async () => { calls++; return c; })).rejects.toThrow();
      expect(calls).toBe(0);
      // Backend disappearance is fixture cleanup, not terminal/cancellation evidence.
      await expect.poll(async () => (await admin.query("SELECT pid FROM pg_stat_activity WHERE application_name='odap-postgresql-preview'")).rows.length,
        { timeout: 5000, interval: 20 }).toBe(0);
    } finally { pending.destroy(); await settled; await host.close(); }
  }, c, { ...d, table: { ...d.table, name: "crash_orders" } }, 1);
});

it("bounds host preparation without blocking signed inspection or consuming refused attempts", async () => {
  await governedFixture(async db => {
    const a = await approvePostgresAgentFixture(db), secret = "synthetic-admission-only";
    const entered = postgresBarrier(), release = postgresBarrier();
    let resolutions = 0;
    const handler = createPostgresGateway({ origin: pgAgentOrigin, env: { DB: db, AUTH_COOKIE_SECRET: secret },
      maxConcurrentExecutions: 1, resolve: async () => { resolutions++; entered.resolve(); await release.promise; return config; } });
    const cookie = SESSION_COOKIE + "=" + await signAuthPayload({ provider: "google", providerId: "reader", email: "test@example.test",
      name: "Synthetic", role: "admin", expiresAt: Date.now() + 600000 }, secret);
    const pending = handler(new Request(`${pgAgentOrigin}/postgresql/tenant-a/execute`, { method: "POST",
      headers: { Origin: pgAgentOrigin, "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify({ requestId: "request" }) }));
    const agent = (operation: "execute" | "inspect") => handler(new Request(`${pgAgentOrigin}/postgresql/tenant-a/agent-${operation}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ delegationId: a.delegationId, signature: operation === "execute" ? a.signature : a.inspectSignature }),
    }));
    try {
      await entered.promise;
      expect((await agent("execute")).status).toBe(429);
      expect((await agent("inspect")).status).toBe(200);
      expect(resolutions).toBe(1);
      expect(await db.prepare("SELECT COUNT(*) AS n FROM postgresql_read_claims").bind().first()).toEqual({ n: 0 });
    } finally { release.resolve(); await pending; }
    expect(await (await pending).json()).toMatchObject({ ok: true, result: { outcome: "succeeded", value: "3" } });
    expect(await (await agent("execute")).json()).toMatchObject({ ok: true, result: { outcome: "succeeded", value: "3" } });
    expect(resolutions).toBe(2);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM postgresql_read_claims").bind().first()).toEqual({ n: 2 });
  });
});

it.each([
  ["INT16", "small_value", "32767"], ["INT32", "integer_value", "2147483647"], ["DATE", "day_value", "2024-02-29"],
  ["TIME", "time_value", "12:30:45.123456"], ["TIMESTAMP", "local_value", "2024-11-03T01:30:00.123456"],
  ["TIMESTAMPTZ", "instant_value", "2024-11-03T01:30:00.123456-04:00"],
  ["TIMESTAMPTZ", "instant_value", "2024-11-03T01:30:00.123456-05:00"],
  ["TIMESTAMPTZ", "instant_value", "2024-11-03T05:30:00.123456Z"],
  ["UUID", "uuid_value", "00000000-0000-0000-0000-000000000001"],
])("preserves exact %s filter %s=%s on the real engine with tenant isolation", async (type, column, value) => {
  const definition = { ...d, table: { ...d.table, name: "typed_orders" }, filters: { value: { column, type } } };
  await governedFixture(async db => {
    expect(await executeGovernedPostgresRead(pgAccess(db), "request", async () => config)).toMatchObject({ outcome: "succeeded", value: "1" });
  }, config, definition, 2, { ...pgAction, parameters: { value } });
});
it.each([["INT16", "small_value"], ["INT32", "integer_value"]])("returns exact %s SUM on the real engine", async (type, column) => {
  await governedFixture(async db => {
    expect(await executeGovernedPostgresRead(pgAccess(db), "request", async () => config)).toMatchObject({ outcome: "succeeded", value: "-1" });
  }, config, { ...d, table: { ...d.table, name: "typed_orders" }, measure: { aggregate: "SUM", column, type } });
});
it("rejects a temporal live OID mismatch before claiming", async () => {
  const r = await postgresRead({ ...d, filters: { value: { column: "label", type: "DATE" } } }, { value: "2024-02-29" });
  let claims = 0;
  expect(await executePostgresMetric(config, r, async () => { claims++; return true; }))
    .toMatchObject({ outcome: "not-submitted", claim: "not-attempted" });
  expect(claims).toBe(0);
});

it.each([{ agent: false, mcp: false }, { agent: false, mcp: true }, { agent: true, mcp: false }, { agent: true, mcp: true }])(
  "delivers authorized active cancellation to the original query (Agent=$agent MCP/TLS=$mcp)", async ({ agent, mcp }) => {
  const c: PostgresHostConfig = { ...config, statementTimeoutMs: 15000, deadlineMs: 20000,
    tls: mcp ? { ca: readFileSync(".tmp/postgresql-tls/server.crt", "utf8") } : { insecureLoopback: true } };
  await governedFixture(async (db, file) => {
    const otherHost = jobTransactionalDatabase(() => file), secret = "synthetic-pg-cancel-only";
    const a = agent ? await approvePostgresAgentFixture(db) : undefined, requestId = agent ? "agent-request" : "request";
    const handler = createPostgresGateway({ origin: pgAgentOrigin, env: { DB: otherHost, AUTH_COOKIE_SECRET: secret }, resolve: async () => c });
    const cancel = async (principal: string) => {
      const cookie = SESSION_COOKIE + "=" + await signAuthPayload({ provider: "google", providerId: principal, email: "test@example.test",
        name: "Synthetic", role: "admin", expiresAt: Date.now() + 600000 }, secret);
      const response = await handler(new Request(`${pgAgentOrigin}/postgresql/tenant-a/${mcp ? "mcp" : "cancel"}`, { method: "POST",
        headers: { Origin: pgAgentOrigin, "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify(mcp ? { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "postgresql_cancel", arguments: { requestId } } } : { requestId }) }));
      const body = await response.json();
      return { ok: mcp ? !body.result.isError : body.ok, result: mcp && !body.result.isError ? JSON.parse(body.result.content[0].text) : body.result };
    };
    const started = Date.now();
    const running = a ? postgresAgentOperation(db, pgAgentOrigin, "tenant-a", a.delegationId, a.signature, "execute", async () => c) :
      executeGovernedPostgresRead(pgAccess(db), requestId, async () => c);
    const unrelated = new Client({ host: config.host, port: config.port, database: config.database, user: config.user,
      password: config.password, ssl: false, connectionTimeoutMillis: 3000, statement_timeout: 5000 });
    try {
      await expect.poll(async () => (await admin.query(`SELECT pid FROM pg_stat_activity
        WHERE application_name='odap-postgresql-preview' AND datname='odap_pg_fixture' AND usename='reader_a'
          AND state='active' AND wait_event='PgSleep' AND query LIKE '%AS metric_value FROM ONLY%crash_orders%'`)).rows.length,
      { timeout: 5000, interval: 10 }).toBe(1);
      expect((await cancel("other-owner")).ok).toBe(false);
      await unrelated.connect(); const unaffected = unrelated.query("SELECT pg_sleep(2)");
      // Attach immediately so a faulty cancellation implementation cannot create an unhandled rejection.
      const unaffectedResult = unaffected.then(() => true, () => false);
      const requested = await cancel(mcp ? "owner" : "reader");
      expect(requested).toMatchObject({ ok: true, result: { status: "cancellation-requested", cancellationConfirmed: false } });
      expect(await running).toMatchObject({ outcome: "failed", sqlState: "57014", claim: "confirmed" });
      expect(Date.now() - started).toBeLessThan(10000); // Below the configured 15-second statement timeout.
      expect(await unaffectedResult).toBe(true);
      const inspected = await inspectPostgresRead(pgAccess(otherHost), requestId);
      expect(inspected).toMatchObject({ state: "failed", terminal_sql_state: "57014", unresolved_claims: 0, used_attempts: 1,
        cancellation_requested_at: expect.any(String) });
      expect(inspected.receiptIds).toContain("pg-cancel-" + inspected.intent_id);
      expect(inspected.receiptIds).toContain("pg-failed-" + inspected.intent_id);
      expect((await cancel("reader")).result).toMatchObject({ cancellationConfirmed: false });
    } finally { await running; await unrelated.end(); }
  }, c, { ...d, table: { ...d.table, name: "crash_orders" } });
}, 30000);

it.each(["untrusted", "hostname"])("refuses cancellation TLS %s mismatch without plaintext fallback", async mode => {
  const probe = new Client({ host: config.host, port: config.port, database: config.database, user: config.user,
    password: config.password, ssl: false, connectionTimeoutMillis: 3000, statement_timeout: 5000 });
  let key: PostgresBackendKey | undefined;
  probe.connection.once("backendKeyData", (value: PostgresBackendKey) => { key = value; });
  try {
    await probe.connect(); expect(key).toBeDefined();
    const query = probe.query("SELECT pg_sleep(2)").then(() => true, () => false);
    await sendPostgresCancellation({ ...config, host: mode === "hostname" ? "localhost" : "127.0.0.1",
      tls: mode === "hostname" ? { ca: readFileSync(".tmp/postgresql-tls/server.crt", "utf8") } : {} }, key!, new AbortController().signal);
    expect(await query).toBe(true);
  } finally { key = undefined; await probe.end(); }
});

it.each([false, true])("enforces durable capacity across session and Agent hosts during a real query (Agent wins=%s)", async agentWins => {
  const c = { ...config, statementTimeoutMs: 2000, deadlineMs: 8000 };
  await governedFixture(async (db, file) => {
    const a = await approvePostgresAgentFixture(db);
    // A distinct control binding opens fresh SQLite connections, not a process-local semaphore.
    const otherHost = jobTransactionalDatabase(() => file);
    const agentRead = () => postgresAgentOperation(otherHost, pgAgentOrigin, "tenant-a", a.delegationId, a.signature, "execute", async () => c);
    const sessionRead = () => executeGovernedPostgresRead(pgAccess(db), "request", async () => c);
    const first = agentWins ? agentRead() : sessionRead();
    try {
      await expect.poll(async () => (await admin.query(`SELECT pid FROM pg_stat_activity
        WHERE datname='odap_pg_fixture' AND usename='reader_a' AND application_name='odap-postgresql-preview'
          AND state='active' AND wait_event='PgSleep' AND query LIKE '%AS metric_value FROM ONLY%crash_orders%'`)).rows.length,
      { timeout: 5000, interval: 10 }).toBe(1);
      expect(await (agentWins ? sessionRead() : agentRead())).toMatchObject({ outcome: "observation-required", claim: "unknown" });
      expect(await inspectPostgresRead(pgAccess(db), "request")).toMatchObject({ unresolved_claims: 1, used_attempts: 1, limit_in_flight: 1 });
      expect(await first).toMatchObject({ outcome: "failed", sqlState: "57014" });
      expect(await inspectPostgresRead(pgAccess(db), "request")).toMatchObject({ unresolved_claims: 0, used_attempts: 1 });
      expect(await (agentWins ? sessionRead() : agentRead())).toMatchObject({ outcome: "failed", sqlState: "57014" });
      expect(await inspectPostgresRead(pgAccess(db), "request")).toMatchObject({ unresolved_claims: 0, used_attempts: 2 });
    } finally { await first; }
  }, c, { ...d, table: { ...d.table, name: "crash_orders" } }, 1);
}, 30000);

it.each([false, true])("executes a signed delegated PostgreSQL read and recovers without resubmitting (MCP=%s)", async mcp => {
  await governedFixture(async db => {
    const a = await approvePostgresAgentFixture(db);
    const handler = createPostgresGateway({ origin: pgAgentOrigin, env: { DB: db }, resolve: async () => config });
    const call = (operation: string, signature: string) => handler(new Request(`${pgAgentOrigin}/postgresql/tenant-a/${mcp ? "agent-mcp" : "agent-" + operation}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(mcp ? {
        jsonrpc: "2.0", id: "agent", method: "tools/call", params: { name: "postgresql_agent_" + operation, arguments: { delegationId: a.delegationId, signature } },
      } : { delegationId: a.delegationId, signature }),
    }));
    const response = await call("execute", a.signature); expect(response.status).toBe(200);
    const body = await response.json(); const result = mcp ? JSON.parse(body.result.content[0].text) : body.result;
    expect(result).toMatchObject({ outcome: "succeeded", value: "3" });
    expect((await call("execute", a.signature)).status).toBe(403);
    const recovery = await (await call("inspect", a.inspectSignature)).json();
    expect(mcp ? JSON.parse(recovery.result.content[0].text) : recovery.result).toMatchObject({ state: "succeeded", agentId: "agent-one" });
    expect(await inspectPostgresRead(pgAccess(db), "agent-request")).toMatchObject({ used_attempts: 1, unresolved_claims: 0 });
  });
});
it("does not submit when delegated consent is revoked during actual provider preparation", async () => {
  await governedFixture(async db => {
    const a = await approvePostgresAgentFixture(db);
    const result = await postgresAgentOperation(db, pgAgentOrigin, "tenant-a", a.delegationId, a.signature, "execute", async () => {
      await revokePostgresDelegation(pgAccess(db), pgAgentOrigin, a.delegationId); return config;
    });
    expect(result).toMatchObject({ outcome: "not-submitted", claim: "denied" });
    expect(await inspectPostgresRead(pgAccess(db), "agent-request")).toMatchObject({ used_attempts: 0, state: "not-submitted" });
  });
});
it("records acknowledged delegated statement timeout without refund or replay", async () => {
  const c = { ...config, statementTimeoutMs: 100, lockTimeoutMs: 50 };
  await governedFixture(async db => {
    const a = await approvePostgresAgentFixture(db);
    expect(await postgresAgentOperation(db, pgAgentOrigin, "tenant-a", a.delegationId, a.signature, "execute", async () => c))
      .toMatchObject({ outcome: "failed", claim: "confirmed", sqlState: "57014" });
    expect(await postgresAgentOperation(db, pgAgentOrigin, "tenant-a", a.delegationId, a.inspectSignature, "inspect", async () => c))
      .toMatchObject({ state: "failed", terminalSqlState: "57014" });
    await expect(postgresAgentOperation(db, pgAgentOrigin, "tenant-a", a.delegationId, a.signature, "execute", async () => c)).rejects.toThrow();
  }, c, { ...d, table: { ...d.table, name: "slow_orders" } });
});

it("executes with durable authority and a confirmed receipt, then refuses replay", async () => {
  await governedFixture(async db => {
    expect(await executeGovernedPostgresRead(pgAccess(db), "request", async () => config))
      .toMatchObject({ outcome: "succeeded", value: "3", monetaryCost: "unpriced" });
    const inspected = await inspectPostgresRead(pgAccess(db), "request");
    expect(inspected).toMatchObject({ state: "succeeded", used_attempts: 1 }); expect(inspected.receiptIds).toHaveLength(2);
    await expect(executeGovernedPostgresRead(pgAccess(db), "request", async () => config)).rejects.toThrow();
  });
});
it("allows exactly one real-engine submission under concurrent governed execution", async () => {
  await governedFixture(async db => {
    const results = await Promise.allSettled([1, 2, 3].map(() => executeGovernedPostgresRead(pgAccess(db), "request", async () => config)));
    expect(results.filter(r => r.status === "fulfilled" && r.value.outcome === "succeeded")).toHaveLength(1);
    expect(await inspectPostgresRead(pgAccess(db), "request")).toMatchObject({ used_attempts: 1 });
  });
});
it("appends terminal failure while retaining consumed attempt and earlier pending receipt", async () => {
  const c = { ...config, statementTimeoutMs: 100, lockTimeoutMs: 50 };
  await governedFixture(async db => {
    const result = await executeGovernedPostgresRead(pgAccess(db), "request", async () => c);
    expect(result).toMatchObject({ outcome: "failed", claim: "confirmed", sqlState: "57014" });
    expect(result).not.toHaveProperty("value");
    expect(await inspectPostgresRead(pgAccess(db), "request")).toMatchObject({ state: "failed", used_attempts: 1, terminal_sql_state: "57014" });
    await expect(executeGovernedPostgresRead(pgAccess(db), "request", async () => c)).rejects.toThrow();
  }, c, { ...d, table: { ...d.table, name: "slow_orders" } });
});
it("rejects resolver role and endpoint substitution before connecting", async () => {
  await governedFixture(async db => {
    for (const c of [{ ...config, user: "reader_b" }, { ...config, port: 55433 }, { ...config, statementTimeoutMs: 500 }]) {
      await expect(executeGovernedPostgresRead(pgAccess(db), "request", async () => c)).rejects.toThrow();
    }
    expect(await inspectPostgresRead(pgAccess(db), "request")).toMatchObject({ used_attempts: 0 });
  });
});
it("recovers a terminal receipt after its write acknowledgement is lost", async () => {
  const c = { ...config, statementTimeoutMs: 100, lockTimeoutMs: 50 };
  await governedFixture(async db => {
    const fault: D1Database = { prepare(sql) {
      const prepared = db.prepare(sql);
      return { ...prepared, bind(...params) {
        const statement = prepared.bind(...params);
        return { ...statement, async first<T>() {
          const value = await statement.first<T>();
          if (sql.startsWith("INSERT INTO postgresql_terminal_failures")) throw new Error("synthetic acknowledgement loss");
          return value;
        } };
      } };
    } };
    expect(await executeGovernedPostgresRead(pgAccess(fault), "request", async () => c))
      .toMatchObject({ outcome: "observation-required", claim: "confirmed" });
    expect(await inspectPostgresRead(pgAccess(db), "request"))
      .toMatchObject({ state: "failed", terminal_sql_state: "57014", used_attempts: 1, unresolved_claims: 0 });
    await expect(executeGovernedPostgresRead(pgAccess(db), "request", async () => c)).rejects.toThrow();
  }, c, { ...d, table: { ...d.table, name: "slow_orders" } });
});
it.each(["claim", "observation"])("does not manufacture success after a lost %s acknowledgement", async phase => {
  await governedFixture(async db => {
    const fault: D1Database = { prepare(sql) {
      const prepared = db.prepare(sql);
      return { ...prepared, bind(...params) {
        const statement = prepared.bind(...params);
        return { ...statement, async first<T>() {
          const value = await statement.first<T>();
          if (sql.startsWith("INSERT INTO postgresql_read_" + (phase === "claim" ? "claims" : "observations"))) {
            throw new Error("synthetic acknowledgement loss");
          }
          return value;
        } };
      } };
    } };
    const result = await executeGovernedPostgresRead(pgAccess(fault), "request", async () => config);
    expect(result.outcome).toBe("observation-required"); expect(result).not.toHaveProperty("value");
    expect(await inspectPostgresRead(pgAccess(db), "request"))
      .toMatchObject({ state: phase === "claim" ? "observation-required" : "succeeded", used_attempts: 1,
        unresolved_claims: phase === "claim" ? 1 : 0 });
    await expect(executeGovernedPostgresRead(pgAccess(db), "request", async () => config)).rejects.toThrow();
  });
});
it("executes the same governed request through authenticated MCP and recovers through REST", async () => {
  await governedFixture(async db => {
    const secret = "synthetic-pg-mcp-only";
    const cookie = SESSION_COOKIE + "=" + await signAuthPayload({ provider: "google", providerId: "reader", email: "test@example.test",
      name: "Synthetic", role: "admin", expiresAt: Date.now() + 600000 }, secret);
    const handler = createPostgresGateway({ origin: "https://gateway.test", env: { DB: db, AUTH_COOKIE_SECRET: secret }, resolve: async () => config });
    const headers = { Origin: "https://gateway.test", "Content-Type": "application/json", Cookie: cookie };
    const response = await handler(new Request("https://gateway.test/postgresql/tenant-a/mcp", { method: "POST", headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "postgresql_execute", arguments: { requestId: "request" } } }) }));
    const rpc = await response.json() as { result: { isError: boolean; content: { text: string }[] } };
    expect(rpc.result.isError).toBe(false); expect(JSON.parse(rpc.result.content[0].text)).toMatchObject({ outcome: "succeeded", value: "3" });
    const history = await handler(new Request("https://gateway.test/postgresql/tenant-a/inspect", { method: "POST", headers,
      body: JSON.stringify({ requestId: "request" }) }));
    expect(await history.json()).toMatchObject({ ok: true, result: { state: "succeeded", used_attempts: 1 } });
  });
});
it("verifies the fixture CA and hostname for a governed TLS query", async () => {
  const c = { ...config, tls: { ca: readFileSync(".tmp/postgresql-tls/server.crt", "utf8") } };
  await governedFixture(async db => {
    expect(await executeGovernedPostgresRead(pgAccess(db), "request", async () => c)).toMatchObject({ outcome: "succeeded", value: "3" });
  }, c);
});
it.each(["untrusted", "hostname"])("rejects a TLS %s mismatch before any claim", async mode => {
  const ca = readFileSync(".tmp/postgresql-tls/server.crt", "utf8");
  const c = { ...config, host: mode === "hostname" ? "localhost" : "127.0.0.1", tls: mode === "hostname" ? { ca } : {} };
  const probe = new Client({ host: c.host, port: c.port, database: c.database, user: c.user, password: c.password,
    ssl: { rejectUnauthorized: true, ...(mode === "hostname" ? { ca } : {}) }, connectionTimeoutMillis: 5000 });
  try {
    await expect(probe.connect()).rejects.toMatchObject({ code: mode === "hostname" ? "ERR_TLS_CERT_ALTNAME_INVALID" : "DEPTH_ZERO_SELF_SIGNED_CERT" });
  } finally { await probe.end(); }
  let claims = 0;
  expect(await executePostgresMetric(c, await postgresRead(), async () => { claims++; return true; }))
    .toMatchObject({ outcome: "not-submitted", claim: "not-attempted" });
  expect(claims).toBe(0);
});

it("executes a real isolated tenant count after a bound claim", async () => {
  let claims = 0;
  let binding: PostgresClaim | undefined;
  const result = await executePostgresMetric(config, await postgresRead(), async value => {
    binding = value;
    claims++; return true;
  });
  expect(claims).toBe(1); expect(result).toMatchObject({ outcome: "succeeded", value: "3", serverVersion: fixtureVersion });
  expect(binding?.database).toBe(config.database); expect(binding?.role).toBe("reader_a");
  expect(binding?.statementDigest).toMatch(/^sha256:[a-f0-9]{64}$/); expect(Object.isFrozen(binding)).toBe(true);
});
it("preserves large integer sums", async () => {
  expect(await executePostgresMetric(config, await postgresRead({ ...d, measure: { aggregate: "SUM", column: "amount", type: "INT64" } }),
    async () => true)).toMatchObject({ outcome: "succeeded", value: "9007199254741000" });
});
it("preserves exact numeric sums", async () => {
  expect(await executePostgresMetric(config, await postgresRead({ ...d, measure: { aggregate: "SUM", column: "price", type: "DECIMAL" } }),
    async () => true)).toMatchObject({ outcome: "succeeded", value: "12345678901234567890.123456790" });
});
it.each([{ value: false, count: "2" }, { value: true, count: "0" }, { value: null, count: "1" }])(
  "does not conflate boolean/null $value", async ({ value, count }) => {
  expect(await executePostgresMetric(config, await postgresRead({ ...d, filters: { value: { column: "active", type: "BOOL" } } }, { value }),
    async () => true)).toMatchObject({ outcome: "succeeded", value: count });
});
it("does not execute SQL embedded in a parameter", async () => {
  expect(await executePostgresMetric(config, await postgresRead({ ...d, filters: { value: { column: "label", type: "STRING" } } },
    { value: "' OR true; SELECT pg_sleep(30); --" }), async () => true)).toMatchObject({ outcome: "succeeded", value: "0" });
});
it("returns null, not zero, for a SUM without matching rows", async () => {
  expect(await executePostgresMetric(config, await postgresRead({ ...d, measure: { aggregate: "SUM", column: "amount", type: "INT64" },
    filters: { value: { column: "label", type: "STRING" } } }, { value: "absent" }), async () => true))
    .toMatchObject({ outcome: "succeeded", value: null });
});
it("enforces the tenant predicate even with a permissive RLS policy", async () => {
  const read = await postgresRead({ ...d, table: { ...d.table, name: "slow_orders" } }); read.source.table = "slow_orders";
  expect(await executePostgresMetric({ ...config, statementTimeoutMs: 2000 }, read, async () => true))
    .toMatchObject({ outcome: "succeeded", value: "3" });
});
it("enforces database RLS against a different release tenant", async () => {
  const r = await postgresRead({ ...d, tenantId: "tenant-b" }, {}, { tenantId: "tenant-b" });
  expect(await executePostgresMetric(config, r, async () => true)).toMatchObject({ outcome: "succeeded", value: "0" });
  expect(await executePostgresMetric({ ...config, user: "reader_b" }, r, async () => true)).toMatchObject({ outcome: "succeeded", value: "1" });
});
it.each(["unprotected", "orders_view"])("rejects unsupported relation %s before claim", async table => {
  const r = await postgresRead({ ...d, table: { ...d.table, name: table } }); r.source.table = table;
  let claims = 0;
  expect(await executePostgresMetric(config, r, async () => { claims++; return true; }))
    .toMatchObject({ outcome: "not-submitted", claim: "not-attempted", reason: "preflight-rejected" });
  expect(claims).toBe(0);
});
it("rejects custom domains instead of invoking unknown coercions", async () => {
  const r = await postgresRead({ ...d, table: { ...d.table, name: "domain_orders" },
    measure: { aggregate: "SUM", column: "amount", type: "INT64" } }); r.source.table = "domain_orders";
  expect(await executePostgresMetric(config, r, async () => true)).toMatchObject({ outcome: "not-submitted", claim: "not-attempted" });
});
it("rejects superuser before claim", async () => {
  expect(await executePostgresMetric({ ...config, user: "postgres", password: "synthetic-ci-only" }, await postgresRead(), async () => true))
    .toMatchObject({ outcome: "not-submitted", claim: "not-attempted" });
});
it("rejects an ordinary login with BYPASSRLS", async () => {
  await admin.query("ALTER ROLE reader_a BYPASSRLS");
  try { expect(await executePostgresMetric(config, await postgresRead(), async () => true))
    .toMatchObject({ outcome: "not-submitted", claim: "not-attempted" }); }
  finally { await admin.query("ALTER ROLE reader_a NOBYPASSRLS"); }
});
it("rejects column-level write privileges", async () => {
  await admin.query("GRANT UPDATE (amount) ON metrics.orders TO reader_a");
  try { expect(await executePostgresMetric(config, await postgresRead(), async () => true))
    .toMatchObject({ outcome: "not-submitted", claim: "not-attempted" }); }
  finally { await admin.query("REVOKE UPDATE (amount) ON metrics.orders FROM reader_a"); }
});
it("rejects declined and ambiguous claims without retrying them", async () => {
  let claims = 0;
  expect(await executePostgresMetric(config, await postgresRead(), async () => { claims++; return false; }))
    .toMatchObject({ outcome: "not-submitted", claim: "denied" });
  expect(await executePostgresMetric(config, await postgresRead(), async () => { claims++; throw new Error("synthetic claim acknowledgement loss"); }))
    .toMatchObject({ outcome: "not-submitted", claim: "unknown" });
  expect(claims).toBe(2);
});
it("rechecks database permission when revoked after the host claim", async () => {
  try {
    expect(await executePostgresMetric(config, await postgresRead(), async () => {
      await admin.query("REVOKE SELECT ON metrics.orders FROM reader_a"); return true;
    })).toMatchObject({ outcome: "failed", claim: "confirmed", sqlState: "42501" });
  } finally { await admin.query("GRANT SELECT ON metrics.orders TO reader_a"); }
});
it("acknowledges a real server statement timeout without refunding its claim", async () => {
  const r = await postgresRead({ ...d, table: { ...d.table, name: "slow_orders" } }); r.source.table = "slow_orders";
  const start = Date.now();
  expect(await executePostgresMetric({ ...config, statementTimeoutMs: 50, lockTimeoutMs: 25 }, r, async () => true))
    .toMatchObject({ outcome: "failed", claim: "confirmed", sqlState: "57014" });
  expect(Date.now() - start).toBeLessThan(4000);
});
it("bounds preflight table locking before the claim", async () => {
  await admin.query("BEGIN");
  await admin.query("LOCK TABLE metrics.orders IN ACCESS EXCLUSIVE MODE");
  try {
    expect(await executePostgresMetric(config, await postgresRead(), async () => true))
      .toMatchObject({ outcome: "not-submitted", claim: "not-attempted" });
  } finally { await admin.query("ROLLBACK"); }
});
it("requires the metric error and rollback acknowledgement after a real cancel request", async () => {
  const r = await postgresRead({ ...d, table: { ...d.table, name: "crash_orders" } }); r.source.table = "crash_orders";
  let cancellation: Promise<void> | undefined;
  const result = await executePostgresMetric({ ...config, statementTimeoutMs: 3000, deadlineMs: 6000 }, r, async () => {
    cancellation = (async () => {
      await expect.poll(async () => (await admin.query(`SELECT pid FROM pg_stat_activity WHERE application_name='odap-postgresql-preview'
        AND datname='odap_pg_fixture' AND usename='reader_a' AND state='active' AND wait_event='PgSleep'
        AND query LIKE '%AS metric_value FROM ONLY%crash_orders%'`)).rows.length, { timeout: 2000, interval: 10 }).toBe(1);
      const response = await admin.query(`SELECT pg_cancel_backend(pid) AS requested FROM pg_stat_activity
        WHERE application_name='odap-postgresql-preview' AND datname='odap_pg_fixture' AND usename='reader_a'
        AND state='active' AND query LIKE '%AS metric_value FROM ONLY%crash_orders%'`);
      expect(response.rows).toEqual([{ requested: true }]);
    })();
    return true;
  });
  await cancellation;
  expect(result).toMatchObject({ outcome: "failed", claim: "confirmed", sqlState: "57014" });
  expect(result).not.toHaveProperty("value");
});
it("retains uncertainty on server-side connection termination without retry", async () => {
  const r = await postgresRead({ ...d, table: { ...d.table, name: "slow_orders" } }); r.source.table = "slow_orders";
  let terminate: Promise<void> | undefined, claims = 0;
  const result = await executePostgresMetric(config, r, async () => {
    claims++;
    terminate = (async () => {
      await new Promise(resolve => setTimeout(resolve, 40));
      const found = await admin.query(`SELECT pg_terminate_backend(pid) AS terminated FROM pg_stat_activity
        WHERE application_name = 'odap-postgresql-preview' AND usename = 'reader_a' AND datname = 'odap_pg_fixture'`);
      expect(found.rows).toEqual([{ terminated: true }]);
    })();
    return true;
  });
  await terminate;
  expect(claims).toBe(1); expect(result).toMatchObject({ outcome: "observation-required", claim: "confirmed" });
});
it("aborts only its dedicated connection and does not claim terminal cancellation", async () => {
  const r = await postgresRead({ ...d, table: { ...d.table, name: "slow_orders" } }); r.source.table = "slow_orders";
  const controller = new AbortController();
  expect(await executePostgresMetric(config, r, async () => {
    setTimeout(() => controller.abort(), 30); return true;
  }, controller.signal)).toMatchObject({ outcome: "observation-required", claim: "confirmed" });
});
it("retains durable capacity after a real governed connection abort", async () => {
  const c = { ...config, statementTimeoutMs: 2000, deadlineMs: 8000 };
  await governedFixture(async db => {
    await approvePostgresFixture(db, "second"); const controller = new AbortController();
    const first = executeGovernedPostgresRead(pgAccess(db), "request", async () => c, controller.signal);
    try {
      await expect.poll(async () => (await admin.query(`SELECT pid FROM pg_stat_activity
        WHERE datname='odap_pg_fixture' AND usename='reader_a' AND application_name='odap-postgresql-preview'
        AND state='active' AND wait_event='PgSleep' AND query LIKE '%AS metric_value FROM ONLY%crash_orders%'`)).rows.length,
      { timeout: 5000, interval: 10 }).toBe(1);
      controller.abort();
      expect(await first).toMatchObject({ outcome: "observation-required", claim: "confirmed" });
      expect(await inspectPostgresRead(pgAccess(db), "request")).toMatchObject({ unresolved_claims: 1, used_attempts: 1 });
      expect(await executeGovernedPostgresRead(pgAccess(db), "second", async () => c))
        .toMatchObject({ outcome: "observation-required", claim: "unknown" });
      expect(await inspectPostgresRead(pgAccess(db), "second")).toMatchObject({ unresolved_claims: 1, used_attempts: 1, intent_id: null });
    } finally { controller.abort(); await first; }
    await expect.poll(async () => (await admin.query("SELECT pid FROM pg_stat_activity WHERE application_name='odap-postgresql-preview'")).rows.length,
      { timeout: 7000, interval: 50 }).toBe(0);
  }, c, { ...d, table: { ...d.table, name: "crash_orders" } }, 1);
}, 30000);
it("rejects an already aborted read before claim or connection", async () => {
  expect(await executePostgresMetric(config, await postgresRead(), async () => true, AbortSignal.abort()))
    .toMatchObject({ outcome: "not-submitted", claim: "not-attempted" });
});
it("rejects mismatched database, missing credentials and insecure remote host before claim", async () => {
  for (const change of [{ database: "another_database" }, { password: "" }, { host: "example.invalid" }]) {
    expect(await executePostgresMetric({ ...config, ...change }, await postgresRead(), async () => true))
      .toMatchObject({ outcome: "not-submitted", claim: "not-attempted" });
  }
});
it("proves database read-only enforcement without relying on the compiler", async () => {
  const reader = new Client({ host: config.host, port: config.port, database: config.database,
    user: config.user, password: config.password, ssl: false });
  await reader.connect();
  try {
    await reader.query("BEGIN READ ONLY");
    await expect(reader.query("UPDATE metrics.orders SET amount = 0")).rejects.toMatchObject({ code: "25006" });
    await reader.query("ROLLBACK");
    await expect(reader.query("UPDATE metrics.orders SET amount = 0")).rejects.toMatchObject({ code: "42501" });
  } finally { await reader.end(); }
});
it("closes fixture connections and never changes business rows", async () => {
  expect((await admin.query("SELECT count(*)::text AS n FROM metrics.orders")).rows[0].n).toBe("4");
  await expect.poll(async () => (await admin.query("SELECT pid FROM pg_stat_activity WHERE application_name = 'odap-postgresql-preview'")).rows.length,
    { timeout: 3000, interval: 100 }).toBe(0);
});
