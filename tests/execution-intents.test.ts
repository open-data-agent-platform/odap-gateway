import { describe, expect, it } from "vitest";
import { admitExecutionIntent } from "../lib/execution-intents";
import type { D1Database } from "../lib/d1";

const intent = { id: "i", contractId: "c", budgetId: "b", reservationId: "r", actionDigest: "q", reservedUnits: 30 };
function access(existing: Record<string, unknown> | null = null) {
  let writes = 0;
  const db: D1Database = { prepare() {
    return { bind() { return this; }, async first<T>() { return existing as T | null; },
      async run() { writes++; return { success: true }; }, async all<T>() { return { results: [] as T[] }; } };
  } };
  return { db, tenantId: "t", principalId: "u", writes: () => writes };
}
describe("execution intent admission", () => {
  it("persists a new intent", async () => {
    const scope = access();
    expect(await admitExecutionIntent(scope, intent)).toEqual({ id: "i", replay: false });
    expect(scope.writes()).toBe(1);
  });
  it("returns matching retries without another reservation", async () => {
    const scope = access({ id: "i", contract_id: "c", budget_id: "b", reservation_id: "r", action_digest: "q", reserved_units: 30 });
    expect(await admitExecutionIntent(scope, intent)).toEqual({ id: "i", replay: true });
    expect(scope.writes()).toBe(0);
    await expect(admitExecutionIntent(scope, { ...intent, reservedUnits: 31 })).rejects.toThrow("Idempotency conflict");
  });
  it("rejects negative, fractional and unsafe estimates", async () => {
    for (const reservedUnits of [-1, 0.5, NaN, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(admitExecutionIntent(access(), { ...intent, reservedUnits })).rejects.toThrow();
    }
  });
});
