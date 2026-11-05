import { describe, expect, it } from "vitest";
import { consumeContract, revokeContract, readEffectiveContract } from "../lib/contract-lifecycle";
import type { D1Database } from "../lib/d1";

function access(changes: number) {
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const db: D1Database = { prepare(sql) {
    const stmt = { sql, values: [] as unknown[] }; statements.push(stmt);
    return { bind(...values) { stmt.values = values; return this; },
      async run() { return { success: true, meta: { changes } }; },
      async first<T>() { return null as T | null; },
      async all<T>() { return { results: [] as T[] }; } };
  } };
  return { db, tenantId: "t1", principalId: "google:u1", statements };
}

describe("contract lifecycle primitives", () => {
  it("reports consumption only when the atomic update changes a row", async () => {
    expect(await consumeContract(access(1), "c1")).toBe(true);
    expect(await consumeContract(access(0), "c1")).toBe(false);
    const scope = access(0);
    await consumeContract(scope, "c1");
    expect(scope.statements[0].values).toEqual(["google:u1", "t1", "c1", "t1", "google:u1", "t1", "c1", "google:u1"]);
    expect(scope.statements[0].sql).toContain("julianday('now')");
    expect(scope.statements[0].sql).toContain("state = 'authorized'");
  });
  it("requires owner membership and a revocation reason", async () => {
    const scope = access(1);
    await expect(revokeContract(scope, "c1", " ")).rejects.toThrow();
    expect(scope.statements).toHaveLength(0);
    expect(await revokeContract(scope, "c1", "policy withdrawn")).toBe(true);
    expect(scope.statements[0].sql).toContain("role = 'owner'");
    expect(await revokeContract(access(0), "c1", "policy withdrawn")).toBe(false);
  });
  it("does not substitute original snapshot authority for missing lifecycle state", async () => {
    expect(await readEffectiveContract(access(0), "missing")).toBeNull();
  });
});
