import { describe, expect, it } from "vitest";
import { canonicalControlJson, sha256Text, type SemanticRelease } from "../lib/control-objects";
import { compileReleasedMetric } from "../lib/metric-compiler";
import revenue from "./fixtures/revenue-metric.json";

const read = { profile: "odap.metric-read.v1", target: "orders", metricId: "revenue", parameters: { year: 2026 } };
async function compile(d: unknown, a: unknown = read, override: Partial<SemanticRelease> = {}) {
  const release: SemanticRelease = { schemaVersion: "0.1", tenantId: "t", id: "r", owner: "u",
    sourceRevision: "s1", state: "released", definitionDigest: await sha256Text(canonicalControlJson(d)), ...override };
  return compileReleasedMetric(release, JSON.stringify(d), canonicalControlJson(a), "demo-project");
}

describe("release-bound metric compiler", () => {
  it("keeps hostile string values exclusively in named parameters and orders predicates deterministically", async () => {
    const attack = "' OR TRUE; SELECT * FROM private --";
    const d = { ...revenue, measure: { aggregate: "COUNT_ROWS" }, filters: {
      search: { column: "label", type: "STRING" }, enabled: { column: "active", type: "BOOL" }
    } };
    const q = await compile(d, { ...read, parameters: { search: attack, enabled: false } });
    expect(q.query).toBe("SELECT COUNT(*) AS metric_value FROM `demo-project.analytics.orders` WHERE `active` = @p0 AND `label` = @p1");
    expect(q.queryParameters).toEqual([
      { name: "p0", parameterType: { type: "BOOL" }, parameterValue: { value: "false" } },
      { name: "p1", parameterType: { type: "STRING" }, parameterValue: { value: attack } }
    ]);
  });
  it("allows no predicates only when the release explicitly declares no filters", async () => {
    const q = await compile({ ...revenue, filters: {} }, { ...read, parameters: {} });
    expect(q.query).not.toContain("WHERE");
    expect(q.queryParameters).toEqual([]);
  });
  it.each([
    { ...revenue, table: { ...revenue.table, name: "orders*" } },
    { ...revenue, table: { ...revenue.table, name: "t` JOIN private USING(id) --" } },
    { ...revenue, table: { ...revenue.table, project: "remote-project" } },
    { ...revenue, measure: { aggregate: "SUM", column: "c) FROM private --" } },
    { ...revenue, measure: { aggregate: "SUM", column: "id", join: "private" } },
    { ...revenue, filters: { year: { column: "id", type: "FLOAT64" } } },
    { ...revenue, filters: { year: { column: "f OR TRUE", type: "INT64" } } },
    { ...revenue, profile: "future.v2" }, { ...revenue, sql: "SELECT 1" },
    { ...revenue, sourceRevision: "stale" }, { ...revenue, tenantId: "other" }
  ])("rejects unsupported structure even if its digest matches", async definition => {
    await expect(compile(definition)).rejects.toThrow();
  });
  it.each([{}, { year: "2026" }, { year: null }, { year: true }, { year: 2026, extra: 1 }])(
    "rejects omitted, mistyped or unexpected required parameters", async parameters => {
      await expect(compile(revenue, { ...read, parameters })).rejects.toThrow();
    });
  it("rejects a different metric, target, digest or release state", async () => {
    await expect(compile(revenue, { ...read, target: "other" })).rejects.toThrow();
    await expect(compile(revenue, { ...read, metricId: "other" })).rejects.toThrow();
    await expect(compile(revenue, read, { definitionDigest: "stale" })).rejects.toThrow();
    await expect(compile(revenue, read, { state: "revoked" })).rejects.toThrow();
  });
});
