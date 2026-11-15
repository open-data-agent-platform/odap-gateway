import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { openPostgresSqliteControl } from "../integrations/postgresql/sqlite-control";
import { initializePostgresLocalFixture } from "./fixtures/postgresql-local-store";
import { seedPostgresControl, pgAccess, publishPostgresFixture, approvePostgresFixture } from "./fixtures/postgresql-control";
import { preparePostgresDispatch, claimPostgresRead, inspectPostgresRead } from "../lib/postgresql-control";
import { postgresControlCases } from "./fixtures/postgresql-control-cases";
import { postgresAgentCases } from "./fixtures/postgresql-agent-cases";
import { postgresTerminalCases } from "./fixtures/postgresql-terminal-cases";
import { postgresConcurrencyCases } from "./fixtures/postgresql-concurrency-cases";
import { postgresCancellationCases } from "./fixtures/postgresql-cancellation-cases";

type Store = ReturnType<typeof openPostgresSqliteControl>;
const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
let directory: string, path: string, store: Store;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "odap-pg-local-control-")); path = join(directory, "control.db");
  initializePostgresLocalFixture(path); store = openPostgresSqliteControl(path);
});
afterEach(async () => { store?.close(); await rm(directory, { recursive: true, force: true }); });

describe("Node SQLite binding semantics", () => {
  it("keeps bound data separate from SQL and preserves false zero null exact text and blobs", async () => {
    const statement = store.db.prepare("SELECT ? AS value"), bytes = new Uint8Array([0, 255]).buffer;
    expect(await statement.bind("'; DROP TABLE control_tenants; --").first()).toEqual({ value: "'; DROP TABLE control_tenants; --" });
    for (const value of [false, 0, null, "9007199254740993"]) expect(await statement.bind(value).first("value")).toBe(value === false ? 0 : value);
    const bound = statement.bind(bytes); new Uint8Array(bytes)[0] = 7;
    expect(new Uint8Array((await bound.first<ArrayBuffer>("value"))!)).toEqual(new Uint8Array([0, 255]));
    expect(await store.db.prepare("SELECT 1 AS value WHERE false").first()).toBeNull();
    expect(await store.db.prepare("SELECT 1 AS __proto__").first()).toEqual({ ["__proto__"]: 1 });
  });
  it("rolls back an entire batch on a late constraint error and remains usable", async () => {
    await expect(store.db.batch!([store.db.prepare("INSERT INTO control_tenants VALUES('one','One')"),
      store.db.prepare("INSERT INTO control_tenants VALUES('one','Duplicate')")])).rejects.toThrow("operation unavailable");
    expect(await store.db.prepare("SELECT * FROM control_tenants").all()).toMatchObject({ success: true, results: [] });
    expect(await store.db.prepare("INSERT INTO control_tenants VALUES('two','Two')").run()).toMatchObject({ success: true, meta: { changes: 1 } });
  });
  it.each(["COMMIT", "ROLLBACK", "SAVEPOINT bypass", "PRAGMA foreign_keys=OFF", "ATTACH DATABASE ':memory:' AS bypass",
    "SELECT 1; INSERT INTO control_tenants VALUES('bypass','Bypass')"])("refuses transaction or connection escape %s atomically", async sql => {
    await expect(store.db.batch!([store.db.prepare("INSERT INTO control_tenants VALUES('one','One')"), store.db.prepare(sql)]))
      .rejects.toThrow("operation unavailable");
    expect(await store.db.prepare("SELECT COUNT(*) AS n FROM control_tenants").first("n")).toBe(0);
  });
  it("rejects a statement from another binding before any batch writes", async () => {
    const other = openPostgresSqliteControl(path);
    try {
      await expect(store.db.batch!([store.db.prepare("INSERT INTO control_tenants VALUES('one','One')"),
        other.db.prepare("SELECT 1")])).rejects.toThrow("operation unavailable");
      expect(await other.db.prepare("SELECT COUNT(*) AS n FROM control_tenants").first("n")).toBe(0);
    } finally { other.close(); }
  });
  it("rolls back a write when the requested result column cannot be returned", async () => {
    await expect(store.db.prepare("INSERT INTO control_tenants VALUES('one','One') RETURNING id").first("missing"))
      .rejects.toThrow("operation unavailable");
    expect(await store.db.prepare("SELECT COUNT(*) AS n FROM control_tenants").first("n")).toBe(0);
  });
  it("refuses missing relative empty and schema-drifted files without initialization", async () => {
    expect(() => openPostgresSqliteControl("relative.db")).toThrow("operation unavailable");
    const missing = join(directory, "missing.db");
    expect(() => openPostgresSqliteControl(missing)).toThrow("operation unavailable");
    await expect(stat(missing)).rejects.toMatchObject({ code: "ENOENT" });
    const empty = join(directory, "empty.db"); new DatabaseSync(empty).close();
    expect(() => openPostgresSqliteControl(empty)).toThrow("operation unavailable");
    store.close();
    const native = new DatabaseSync(path);
    native.exec("CREATE TABLE unexpected_schema(value TEXT)"); native.close();
    expect(() => openPostgresSqliteControl(path)).toThrow("operation unavailable");
  });
  it("does not expose SQL or data in errors and refuses unsafe binding values", async () => {
    for (const value of [NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) expect(() => store.db.prepare("SELECT ?").bind(value)).toThrow();
    await expect(store.db.prepare("SELECT 'synthetic-private-value' FROM missing_table").all()).rejects.toThrow(/^PostgreSQL local control store operation unavailable$/);
    await expect(store.db.prepare("SELECT load_extension('synthetic-private-path')").first()).rejects.toThrow(/^PostgreSQL local control store operation unavailable$/);
  });
  it("is durable across close/reopen and never rearms an unresolved claim", async () => {
    await seedPostgresControl(store.db); await publishPostgresFixture(store.db); await approvePostgresFixture(store.db);
    const { row } = await preparePostgresDispatch(pgAccess(store.db), "request");
    expect(await claimPostgresRead(pgAccess(store.db), row, "claimed")).toBe(true);
    store.close(); store = openPostgresSqliteControl(path);
    expect(await inspectPostgresRead(pgAccess(store.db), "request")).toMatchObject({ state: "observation-required", used_attempts: 1 });
    await expect(preparePostgresDispatch(pgAccess(store.db), "request")).rejects.toThrow();
  });
  it("holds an external write lock only for its configured bounded timeout", async () => {
    const native = new DatabaseSync(path); native.exec("BEGIN IMMEDIATE");
    try {
      const started = Date.now();
      await expect(store.db.prepare("INSERT INTO control_tenants VALUES('one','One')").run()).rejects.toThrow("operation unavailable");
      expect(Date.now() - started).toBeLessThan(2000);
    } finally { native.exec("ROLLBACK"); native.close(); }
    expect(await store.db.prepare("SELECT COUNT(*) AS n FROM control_tenants").first("n")).toBe(0);
  });
  it("closes idempotently and rejects previously prepared operations", async () => {
    const statement = store.db.prepare("SELECT 1"); store.close(); store.close();
    await expect(statement.all()).rejects.toThrow("operation unavailable");
  });
  it.each(["SELECT zeroblob(8388609) AS value", "SELECT 9007199254740993 AS value",
    "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<10001) SELECT x FROM n"])(
    "rolls back preceding writes when result bounds or exact numbers fail: %s", async sql => {
      await expect(store.db.batch!([store.db.prepare("INSERT INTO control_tenants VALUES('one','One')"), store.db.prepare(sql)]))
        .rejects.toThrow("operation unavailable");
      expect(await store.db.prepare("SELECT COUNT(*) AS n FROM control_tenants").first("n")).toBe(0);
    });
  it("bounds results across a whole batch rather than per statement", async () => {
    await expect(store.db.batch!([store.db.prepare("SELECT zeroblob(5000000) AS value"),
      store.db.prepare("SELECT zeroblob(5000000) AS value")])).rejects.toThrow("operation unavailable");
    expect(await store.db.prepare("SELECT 1 AS n").first("n")).toBe(1);
  });
});

for (const [name, cases] of [["authority", postgresControlCases], ["Agent", postgresAgentCases],
  ["terminal", postgresTerminalCases], ["concurrency", postgresConcurrencyCases], ["cancellation", postgresCancellationCases]] as const) {
  describe(`shared PostgreSQL ${name} invariants on Node SQLite`, () => {
    beforeEach(async () => { await seedPostgresControl(store.db, undefined, name === "concurrency" ? 10 : 2, undefined,
      name === "concurrency" ? null : 2); });
    cases(() => store.db);
  });
}
