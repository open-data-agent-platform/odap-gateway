import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assessDatabaseReadCapabilities as assess, databaseAdapterInventory } from "../lib/database-adapter-capabilities";

const request = () => ({ schemaVersion: "adapter-read-requirements.v1", engine: "bigquery",
  action: "odap.metric-read.v1", requireProviderVerification: false, limits: [{ unit: "billed-bytes", maximum: 100 }] });

describe("database adapter capability inventory", () => {
  it("only claims the implemented business-query adapter and binds source evidence", () => {
    const implemented = databaseAdapterInventory().filter(a => a.implementation === "implemented");
    expect(implemented.map(a => a.engine)).toEqual(["bigquery"]);
    expect(implemented[0].validation).toBe("offline-only");
    for (const path of implemented[0].evidence) expect(existsSync(path), path).toBe(true);
  });
  it("cannot be mutated into a new execution grant", () => {
    expect(Object.isFrozen(databaseAdapterInventory())).toBe(true);
    for (const entry of databaseAdapterInventory()) {
      expect(Object.isFrozen(entry)).toBe(true);
      expect(Object.isFrozen(entry.actions)).toBe(true);
      expect(Object.isFrozen(entry.queryHardLimits)).toBe(true);
      expect(Object.isFrozen(entry.evidence)).toBe(true);
    }
  });
  it("accepts only offline compatibility, never authority", () => {
    expect(assess(request())).toEqual({ schemaVersion: "adapter-capability-assessment.v1", offlineAssessment: true,
      authorizationGranted: false, compatible: true, reasons: [] });
  });
  it.each(["postgresql", "clickhouse", "trino", "mysql", "mariadb", "duckdb", "sqlite"])("rejects unimplemented %s", engine => {
    expect(assess({ ...request(), engine }).reasons).toEqual(["adapter-not-implemented"]);
  });
  it.each(["d1", "supabase", "neon", "iceberg", "jdbc", "snowflake"])("does not infer support for %s", engine => {
    expect(assess({ ...request(), engine }).reasons).toEqual(["unknown-engine"]);
  });
  it("requires separate provider verification and rejects arbitrary SQL", () => {
    expect(assess({ ...request(), requireProviderVerification: true }).reasons).toEqual(["provider-verification-missing"]);
    expect(assess({ ...request(), action: "raw-sql" }).reasons).toEqual(["unsupported-action"]);
  });
  it.each(["elapsed-ms", "returned-rows", "memory-bytes"])("does not advertise a %s query hard limit", unit => {
    expect(assess({ ...request(), limits: [{ unit, maximum: 1 }] }).reasons).toEqual([`unsupported-query-hard-limit:${unit}`]);
  });
  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "100", null])("rejects unsafe limit %s", maximum => {
    expect(assess({ ...request(), limits: [{ unit: "billed-bytes", maximum }] }).reasons).toEqual(["invalid-requirements"]);
  });
  it.each(["schemaVersion", "engine", "action", "requireProviderVerification", "limits"])("rejects missing %s", field => {
    const value: Record<string, unknown> = request(); delete value[field];
    expect(assess(value).reasons).toEqual(["invalid-requirements"]);
  });
  it("rejects shape changes and extra claims instead of trusting them", () => {
    const values = [null, [], {}, Object.create(request()), { ...request(), schemaVersion: "v2" },
      { ...request(), engine: "BigQuery" }, { ...request(), requireProviderVerification: "false" },
      { ...request(), limits: [] }, { ...request(), limits: [{ unit: "optimizer-cost", maximum: 1 }] },
      { ...request(), limits: [...request().limits, ...request().limits] },
      { ...request(), limits: [{ ...request().limits[0], scope: "node" }] },
      { ...request(), verified: true }, { ...request(), token: "synthetic-secret" }];
    for (const value of values) {
      expect(assess(value)).toMatchObject({ compatible: false, authorizationGranted: false, reasons: ["invalid-requirements"] });
      expect(JSON.stringify(assess(value))).not.toContain("synthetic-secret");
    }
  });
  it("checks all requested limits, not just the first", () => {
    expect(assess({ ...request(), limits: [...request().limits, { unit: "elapsed-ms", maximum: 5 }] }).compatible).toBe(false);
  });
});
