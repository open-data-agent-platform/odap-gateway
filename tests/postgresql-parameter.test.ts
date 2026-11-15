import { describe, expect, it } from "vitest";
import { postgresParameter, postgresParameterTypes } from "../lib/postgresql-parameter";
import { compilePostgresMetric } from "../lib/postgresql-metric-compiler";
import { postgresDefinition as d, postgresRead } from "./fixtures/postgresql";

describe("PostgreSQL exact scalar parameters", () => {
  it.each([
    ["INT16", -32768, "-32768"], ["INT16", "32767", "32767"], ["INT32", -2147483648, "-2147483648"],
    ["INT32", "2147483647", "2147483647"], ["DATE", "0001-01-01", "0001-01-01"], ["DATE", "2000-02-29", "2000-02-29"],
    ["DATE", "9999-12-31", "9999-12-31"], ["TIME", "23:59:59.123456", "23:59:59.123456"],
    ["TIMESTAMP", "2024-11-03T01:30:00.123456", "2024-11-03T01:30:00.123456"],
    ["TIMESTAMPTZ", "2024-11-03T01:30:00.123456-04:00", "2024-11-03T01:30:00.123456-04:00"],
    ["TIMESTAMPTZ", "2024-11-03T01:30:00.123456-05:00", "2024-11-03T01:30:00.123456-05:00"],
    ["TIMESTAMPTZ", "2024-02-29T00:00:00Z", "2024-02-29T00:00:00Z"],
    ["TIMESTAMPTZ", "2024-02-29T00:00:00+14:00", "2024-02-29T00:00:00+14:00"],
    ["TIMESTAMPTZ", "2024-02-29T00:00:00-14:00", "2024-02-29T00:00:00-14:00"],
    ["UUID", "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11", "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11"],
  ])("preserves %s parameter %s without host-zone or precision conversion", (type, value, expected) => {
    expect(postgresParameter(type, value).value).toBe(expected);
  });
  it.each([
    ["INT16", 32768], ["INT16", -32769], ["INT32", 2147483648], ["INT32", -2147483649], ["INT16", -0],
    ["INT32", "01"], ["INT32", "1.0"], ["DATE", "0000-01-01"], ["DATE", "1900-02-29"], ["DATE", "2023-02-29"],
    ["DATE", "2024-00-01"], ["DATE", "2024-13-01"], ["DATE", "2024-01-00"], ["DATE", "2024-04-31"],
    ["DATE", "2024-2-29"], ["DATE", "02/03/2024"], ["DATE", "today"], ["DATE", "infinity"], ["DATE", 20240229],
    ["TIME", "24:00:00"], ["TIME", "12:60:00"], ["TIME", "12:00:60"], ["TIME", "12:00:00.1234567"],
    ["TIME", "12:00:00Z"], ["TIMESTAMP", "2024-02-29 12:00:00"], ["TIMESTAMP", "2024-02-29T12:00:00Z"],
    ["TIMESTAMPTZ", "2024-02-29T12:00:00"], ["TIMESTAMPTZ", "2024-02-29T12:00:00-00:00"],
    ["TIMESTAMPTZ", "2024-02-29T12:00:00+14:01"], ["TIMESTAMPTZ", "2024-02-29T12:00:00+15:00"],
    ["TIMESTAMPTZ", "2024-02-29T12:00:00+01:60"], ["TIMESTAMPTZ", "2024-11-03T01:30:00 America/New_York"],
    ["TIMESTAMPTZ", "2024-02-30T12:00:00Z"], ["TIMESTAMPTZ", "2024-02-29T12:00:00.1234567Z"],
    ["UUID", "A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11"], ["UUID", "a0eebc999c0b4ef8bb6d6bb9bd380a11"],
    ["UUID", "{a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11}"], ["UUID", "' OR true --"],
    ["TIMETZ", null], ["JSONB", {}], ["DATE", new Date("2024-02-29")],
  ])("rejects ambiguous overflowing or unsupported %s parameter %s", (type, value) => {
    expect(() => postgresParameter(type, value)).toThrow();
  });
  it.each(Object.keys(postgresParameterTypes))("retains NULL separately for %s", type => {
    expect(postgresParameter(type, null)).toMatchObject({ value: null });
  });
  it.each(["INT16", "INT32"])("compiles a release-bound %s SUM with the exact live OID", async type => {
    const r = await postgresRead({ ...d, measure: { aggregate: "SUM", column: "amount", type } });
    const q = await compilePostgresMetric(r.release, r.definitionJson, r.canonicalAction, r.source);
    expect(q.columns).toContainEqual({ name: "amount", type }); expect(q.text).toContain('pg_catalog.sum("amount")');
  });
  it("keeps microseconds and explicit DST offsets in distinct action and statement bindings", async () => {
    const compile = async (value: string) => {
      const r = await postgresRead({ ...d, filters: { value: { column: "occurred_at", type: "TIMESTAMPTZ" } } }, { value });
      return compilePostgresMetric(r.release, r.definitionJson, r.canonicalAction, r.source);
    };
    const rows = await Promise.all(["2024-11-03T01:30:00.123456-04:00", "2024-11-03T01:30:00.123457-04:00",
      "2024-11-03T01:30:00.123456-05:00"].map(compile));
    expect(new Set(rows.map(q => q.statementDigest)).size).toBe(3);
    expect(new Set(rows.map(q => q.actionDigest)).size).toBe(3);
    expect(rows[0].text).toContain('"occurred_at" IS NOT DISTINCT FROM $2::pg_catalog.timestamptz');
  });
  it("freezes the shared cast/OID registry against accidental host mutation", () => {
    expect(Object.isFrozen(postgresParameterTypes)).toBe(true);
    expect(Object.values(postgresParameterTypes).every(Object.isFrozen)).toBe(true);
  });
});
