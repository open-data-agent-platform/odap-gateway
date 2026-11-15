import { afterAll, beforeAll, expect, it } from "vitest";
import { Client } from "pg";
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { executePostgresMetric, type PostgresClaim, type PostgresHostConfig } from "./index";
import { postgresDefinition as d, postgresRead } from "../../tests/fixtures/postgresql";

// Fixed disposable fixture only: never accept a business endpoint or credentials.
const config: PostgresHostConfig = { host: "127.0.0.1", port: 55432, database: "odap_pg_fixture",
  user: "reader_a", password: "synthetic-fixture-only", tls: { insecureLoopback: true },
  statementTimeoutMs: 1000, lockTimeoutMs: 200, deadlineMs: 5000 };
const admin = new Client({ host: config.host, port: config.port, database: config.database,
  user: "postgres", password: "synthetic-ci-only", ssl: false, connectionTimeoutMillis: 5000 });

beforeAll(async () => {
  if (process.env.ODAP_POSTGRES_FIXTURE !== "isolated-synthetic-only") throw new Error("Disposable fixture opt-in required");
  await admin.connect();
  const version = (await admin.query("SHOW server_version_num")).rows[0].server_version_num;
  const driverVersion: string = createRequire(import.meta.url)("pg/package.json").version;
  expect(version).toBe("170012");
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
    CREATE DOMAIN metrics.custom_number AS bigint;
    CREATE TABLE metrics.domain_orders (tenant_id text, amount metrics.custom_number);
    ALTER TABLE metrics.domain_orders ENABLE ROW LEVEL SECURITY;
    CREATE POLICY domain_access ON metrics.domain_orders TO reader_a USING (true);
    GRANT SELECT ON metrics.domain_orders TO reader_a;`);
  writeFileSync("postgresql-environment.json", JSON.stringify({ serverVersion: "17.12", serverVersionNum: version,
    driver: "pg", driverVersion, syntheticDataOnly: true, transport: "isolated-loopback-without-TLS",
    productionVerified: false, gatewayDispatchIntegrated: false }, null, 2) + "\n");
});
afterAll(async () => { await admin.end(); });

it("executes a real isolated tenant count after a bound claim", async () => {
  let claims = 0;
  let binding: PostgresClaim | undefined;
  const result = await executePostgresMetric(config, await postgresRead(), async value => {
    binding = value;
    claims++; return true;
  });
  expect(claims).toBe(1); expect(result).toMatchObject({ outcome: "succeeded", value: "3" });
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
    })).toMatchObject({ outcome: "observation-required", claim: "confirmed" });
  } finally { await admin.query("GRANT SELECT ON metrics.orders TO reader_a"); }
});
it("bounds a real slow query with server statement timeout, retaining unresolved claim", async () => {
  const r = await postgresRead({ ...d, table: { ...d.table, name: "slow_orders" } }); r.source.table = "slow_orders";
  const start = Date.now();
  expect(await executePostgresMetric({ ...config, statementTimeoutMs: 50, lockTimeoutMs: 25 }, r, async () => true))
    .toMatchObject({ outcome: "observation-required", claim: "confirmed" });
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
