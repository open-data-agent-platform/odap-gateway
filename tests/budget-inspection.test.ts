import { describe, expect, it, vi } from "vitest";
import { formatMicroUsd, inspectBudget, type BudgetReport } from "../lib/budget-inspection";
import { readBudgetReconciliation } from "../lib/budget-reconciliation";
import type { D1PreparedStatement } from "../lib/d1";

const signal = new AbortController().signal;
const part = () => ({ recorded: 0, settled: 0, pending: 0, recordedActualMicroUsd: "0", pendingReservedMicroUsd: "0" });
function empty(): BudgetReport {
  return { scope: "recorded-budget-accounting-only", tenantId: "team-a", budgetId: "budget-a", consistent: true,
    countersConsistent: true, attributionConsistent: true, completeWorkflowCost: false, issuerAuthenticated: false, executionAuthorized: false,
    sql: part(), model: part(), tool: part(), ledger: { limitMicroUsd: "100", reservedMicroUsd: "0", spentMicroUsd: "0", overrunMicroUsd: "0" },
    totals: { recordedActualMicroUsd: "0", pendingReservedMicroUsd: "0", pendingComponents: 0 },
    difference: { reservedMicroUsd: "0", chargedMicroUsd: "0" },
    issues: { hasUnattributedRecords: false, invalidSqlReceipts: 0, invalidAuxiliaryAudits: 0, invalidAuxiliaryBills: 0 } };
}
const read = (reconciliation: unknown) => inspectBudget("team-a", "budget-a", signal,
  async () => Response.json({ ok: true, reconciliation }));

describe("owner budget inspection", () => {
  it("makes one same-origin uncached GET without caller authority", async () => {
    const report = empty();
    const get = vi.fn(async () => Response.json({ ok: true, reconciliation: report }));
    expect(await inspectBudget("team-a", "budget-a", signal, get)).toEqual({ state: "ready", report });
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith("/api/control/team-a/budget-reconciliation/budget-a", {
      method: "GET", credentials: "same-origin", cache: "no-store", redirect: "error", signal
    });
  });
  it.each(["", "../peer", "other/team", "https://other.test", "t?q=1", "t#x", "t%2Fother", "x".repeat(129), " t", "t\n"])(
    "rejects invalid scope %# without fetching", async value => {
      const get = vi.fn();
      expect(await inspectBudget(value, "budget-a", signal, get)).toEqual({ state: "invalid" });
      expect(await inspectBudget("team-a", value, signal, get)).toEqual({ state: "invalid" });
      expect(get).not.toHaveBeenCalled();
    });
  it.each([[401, "unauthenticated"], [403, "denied"], [404, "unavailable"], [500, "unavailable"], [503, "unavailable"]] as const)(
    "does not turn HTTP %i into an empty report", async (status, state) => {
      expect(await inspectBudget("team-a", "budget-a", signal,
        async () => Response.json({ ok: true, reconciliation: empty() }, { status }))).toEqual({ state });
    });
  it("distinguishes absent accounting schema without exposing server diagnostics", async () => {
    expect(await inspectBudget("team-a", "budget-a", signal, async () => Response.json({
      ok: false, code: "budget_accounting_unavailable", detail: "private"
    }, { status: 503 }))).toEqual({ state: "incompatible" });
    for (const get of [async () => { throw new Error("private"); }, async () => new Response("<html/>"),
      async () => Response.json({ ok: false, reconciliation: empty() }), async () => new Response("private", { status: 503 })])
      expect(await inspectBudget("team-a", "budget-a", signal, get)).toEqual({ state: "unavailable" });
  });
  it("accepts server-produced pending, zero-charge and inconsistent snapshots without calling pending charges final", async () => {
    const statement: D1PreparedStatement = { bind: () => statement, first: async <T>() => snapshot as T,
      all: async () => { throw new Error("Unexpected inventory"); }, run: async () => { throw new Error("Unexpected write"); } };
    const snapshot = { limit_units: 100, reserved_units: 20, spent_units: 0, overrun_units: 0, unattributed: 0,
      sql_rows: JSON.stringify([{ id: "i", reservationId: "r", contractId: "c", reserved: 20, receiptId: null, actual: null, receiptLinked: 1 }]),
      auxiliary_rows: "[]" };
    for (const held of [20, 21]) {
      snapshot.reserved_units = held;
      const report = await readBudgetReconciliation({ db: { prepare: () => statement }, tenantId: "team-a", principalId: "owner" }, "budget-a");
      expect(await read(report)).toEqual({ state: "ready", report });
      expect(report?.totals.pendingComponents).toBe(1);
      expect(report?.consistent).toBe(held === 20);
    }
    const zero = empty();
    zero.sql = { ...part(), recorded: 1, settled: 1 };
    expect(await read(zero)).toEqual({ state: "ready", report: zero });
    const unattributed = empty();
    unattributed.consistent = unattributed.attributionConsistent = false;
    unattributed.issues.hasUnattributedRecords = true;
    expect(await read(unattributed)).toEqual({ state: "ready", report: unattributed });
  });
  it("keeps aggregate amounts above the safe integer limit exact", async () => {
    const report = empty();
    report.sql = { ...part(), recorded: 2, settled: 2, recordedActualMicroUsd: "18014398509481981" };
    report.totals.recordedActualMicroUsd = "18014398509481981";
    report.ledger = { limitMicroUsd: "9007199254740991", reservedMicroUsd: "0", spentMicroUsd: "9007199254740991", overrunMicroUsd: "9007199254740990" };
    expect(await read(report)).toEqual({ state: "ready", report });
    expect(formatMicroUsd(report.totals.recordedActualMicroUsd)).toBe("$18,014,398,509.481981");
  });
  it.each([
    ["wrong tenant", { tenantId: "team-b" }], ["wrong budget", { budgetId: "budget-b" }],
    ["wrong scope", { scope: "all-costs" }], ["full cost claim", { completeWorkflowCost: true }],
    ["issuer claim", { issuerAuthenticated: true }], ["execution claim", { executionAuthorized: true }],
    ["unknown field", { rows: [] }], ["wrong totals", { totals: { recordedActualMicroUsd: "1", pendingReservedMicroUsd: "0", pendingComponents: 0 } }],
    ["wrong difference", { difference: { reservedMicroUsd: "-1", chargedMicroUsd: "0" } }],
    ["wrong flag", { countersConsistent: false }], ["wrong consistency", { consistent: false }],
    ["wrong attribution", { attributionConsistent: false }], ["missing section", { sql: null }]
  ])("refuses %s", async (_label, change) => {
    expect(await read({ ...empty(), ...change })).toEqual({ state: "unavailable" });
  });
  it.each([-1, 0.5, "0", Number.MAX_SAFE_INTEGER + 1, null])("refuses malformed counts %#", async value => {
    expect(await read({ ...empty(), sql: { ...part(), recorded: value } })).toEqual({ state: "unavailable" });
  });
  it.each([0, -1, null, "-0", "01", "1.2", "1e6", "-1", "9".repeat(33)])("refuses malformed amounts %#", async value => {
    expect(await read({ ...empty(), ledger: { ...empty().ledger, limitMicroUsd: value } })).toEqual({ state: "unavailable" });
  });
  it("refuses malformed report shapes and inconsistent component counts", async () => {
    for (const value of [null, [], {}, { ...empty(), sql: { ...part(), settled: 1 } },
      { ...empty(), sql: { ...part(), recorded: 1025, pending: 1025 } },
      { ...empty(), issues: { ...empty().issues, invalidSqlReceipts: -1 } }])
      expect(await read(value)).toEqual({ state: "unavailable" });
  });
});

describe("exact micro-USD formatting", () => {
  it.each([["0", "$0.000000"], ["1", "$0.000001"], ["-1", "-$0.000001"], ["1234567890", "$1,234.567890"]])(
    "formats %s without rounding", (input, expected) => expect(formatMicroUsd(input)).toBe(expected));
  it.each(["-0", "01", "NaN", "1e6", "1.1", ""])("rejects %s", input => expect(() => formatMicroUsd(input)).toThrow());
});
