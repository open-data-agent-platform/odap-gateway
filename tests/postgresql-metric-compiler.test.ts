import { describe, expect, it } from "vitest";
import { compilePostgresMetric, postgresIdentifier } from "../lib/postgresql-metric-compiler";
import { postgresDefinition as d, postgresRead } from "./fixtures/postgresql";

async function compile(definition: unknown = d, params: Record<string, unknown> = {}) {
  const r = await postgresRead(definition, params);
  return compilePostgresMetric(r.release, r.definitionJson, r.canonicalAction, r.source);
}

describe("PostgreSQL release-bound compiler", () => {
  it("always binds the tenant even with no user filters and freezes the generated statement", async () => {
    const q = await compile();
    expect(q.text).toBe('SELECT pg_catalog.count(*) AS metric_value FROM ONLY "metrics"."orders" WHERE "tenant_id" COLLATE "C" = $1::pg_catalog.text COLLATE "C"');
    expect(q.values).toEqual(["tenant-a"]);
    expect(Object.isFrozen(q) && Object.isFrozen(q.values) && Object.isFrozen(q.columns[0])).toBe(true);
  });
  it("keeps injection strings outside SQL and orders parameters deterministically", async () => {
    const attack = "' OR true; DROP TABLE metrics.orders; --";
    const q = await compile({ ...d, filters: { label: { column: "label", type: "STRING" }, active: { column: "active", type: "BOOL" } } },
      { label: attack, active: false });
    expect(q.text).not.toContain(attack);
    expect(q.values).toEqual(["tenant-a", false, attack]);
    expect(q.text).toContain('"active" IS NOT DISTINCT FROM $2::pg_catalog.bool');
  });
  it.each([null, false, true])("preserves boolean/null value %s", async value => {
    const q = await compile({ ...d, filters: { value: { column: "active", type: "BOOL" } } }, { value });
    expect(q.values[1]).toBe(value);
  });
  it.each(["9223372036854775807", "-9223372036854775808", "9007199254740993", 123])("accepts exact int64 %s", async value => {
    const q = await compile({ ...d, filters: { value: { column: "amount", type: "INT64" } } }, { value });
    expect(q.values[1]).toBe(String(value));
  });
  it.each(["9223372036854775808", "-9223372036854775809", 9007199254740992, "1e3", "01", "-0", true, 1.1])(
    "rejects ambiguous/overflow integer %s", async value => {
      await expect(compile({ ...d, filters: { value: { column: "amount", type: "INT64" } } }, { value })).rejects.toThrow();
    });
  it("preserves decimal precision without floating-point conversion", async () => {
    const q = await compile({ ...d, measure: { aggregate: "SUM", column: "price", type: "DECIMAL" },
      filters: { value: { column: "price", type: "DECIMAL" } } }, { value: "12345678901234567890.123456789" });
    expect(q.values[1]).toBe("12345678901234567890.123456789");
    expect(q.text).toContain('pg_catalog.sum("price")');
  });
  it.each([1.5, "NaN", "Infinity", "1e10", "1; SELECT 1", "9".repeat(129)])("rejects nonexact decimal %s", async value => {
    await expect(compile({ ...d, filters: { value: { column: "price", type: "DECIMAL" } } }, { value })).rejects.toThrow();
  });
  it.each(["a".repeat(64), "x.y", 'x"', "x;--", "", "\u0000", "\u4e2d"]) (
    "rejects unsafe/truncated identifier %s", value => expect(() => postgresIdentifier(value)).toThrow());
  it.each([
    { ...d, sql: "SELECT 1" }, { ...d, tenantId: "tenant-b" }, { ...d, sourceRevision: "old" },
    { ...d, table: { ...d.table, database: "other" } }, { ...d, table: { ...d.table, schema: "other" } },
    { ...d, table: { ...d.table, tenantColumn: "label" } }, { ...d, measure: { aggregate: "pg_sleep(10)" } },
    { ...d, measure: { aggregate: "SUM", column: "price", type: "FLOAT64" } },
    { ...d, filters: { bad: { column: "label", type: "TIMESTAMP" } } },
  ])("rejects unsupported or mismatched definition", async definition => expect(compile(definition)).rejects.toThrow());
  it("rejects revoked release, digest/action drift and missing/extra parameters", async () => {
    const r = await postgresRead();
    await expect(compilePostgresMetric({ ...r.release, state: "revoked" }, r.definitionJson, r.canonicalAction, r.source)).rejects.toThrow();
    await expect(compilePostgresMetric({ ...r.release, definitionDigest: "0".repeat(64) }, r.definitionJson, r.canonicalAction, r.source)).rejects.toThrow();
    await expect(compilePostgresMetric(r.release, r.definitionJson, r.canonicalAction.replace('"orders"', '"elsewhere"'), r.source)).rejects.toThrow();
    await expect(compile(d, { extra: 1 })).rejects.toThrow();
    await expect(compile({ ...d, filters: { label: { column: "label", type: "STRING" } } })).rejects.toThrow();
  });
  it("binds parameter values into a different statement digest", async () => {
    const definition = { ...d, filters: { value: { column: "active", type: "BOOL" } } };
    expect((await compile(definition, { value: false })).statementDigest).not.toBe((await compile(definition, { value: null })).statementDigest);
  });
});
