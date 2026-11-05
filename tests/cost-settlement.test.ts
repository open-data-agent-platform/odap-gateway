import { describe, expect, it } from "vitest";
import { settleIntentCost } from "../lib/cost-settlement";
import type { D1Database } from "../lib/d1";

const receipt = { schemaVersion: "0.1", id: "receipt", tenantId: "t", intentId: "i", contractId: "c",
  semanticReleaseId: "r", outcome: "succeeded", reason: "job complete", recordedAt: "2026-11-05T00:00:00.000Z" };
const access = { db: { prepare() { throw new Error("must not access database"); } } as D1Database, tenantId: "t", principalId: "owner" };

describe("cost settlement boundary", () => {
  it("leaves unknown cost pending without touching reservations", async () => {
    expect(await settleIntentCost(access, receipt, null)).toEqual({ settled: false, pending: true });
  });
  it("rejects wrong tenant and nonfinal evidence", async () => {
    await expect(settleIntentCost(access, { ...receipt, tenantId: "other" }, 1)).rejects.toThrow();
    await expect(settleIntentCost(access, { ...receipt, outcome: "pending" }, 1)).rejects.toThrow();
  });
  it("rejects invalid costs and nontransactional storage", async () => {
    for (const cost of [-1, 0.5, NaN, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(settleIntentCost(access, receipt, cost)).rejects.toThrow("Invalid actual cost");
    }
    await expect(settleIntentCost(access, receipt, 1)).rejects.toThrow("Transactional storage required");
  });
});
