import { gatewayPath } from "./gateway-path";
import type { readBudgetReconciliation } from "./budget-reconciliation";

export type BudgetReport = NonNullable<Awaited<ReturnType<typeof readBudgetReconciliation>>>;
export type BudgetInspection = { state: "ready"; report: BudgetReport } |
  { state: "invalid" | "unauthenticated" | "denied" | "incompatible" | "unavailable" };
const routeId = /^[A-Za-z0-9_-]{1,128}$/;
const decimal = /^(0|[1-9][0-9]{0,31})$/;
const signedDecimal = /^(0|-?[1-9][0-9]{0,31})$/;
const components = ["sql", "model", "tool"] as const;
function shape(value: unknown, keys: string[]): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
const count = (value: unknown): value is number => typeof value === "number" &&
  Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
const amount = (value: unknown): value is string => typeof value === "string" && decimal.test(value);

function validReport(value: unknown, tenant: string, budget: string): value is BudgetReport {
  if (!shape(value, ["scope", "tenantId", "budgetId", "consistent", "countersConsistent", "attributionConsistent",
    "completeWorkflowCost", "issuerAuthenticated", "executionAuthorized", ...components, "ledger", "totals", "difference", "issues"]) ||
    value.scope !== "recorded-budget-accounting-only" || value.tenantId !== tenant || value.budgetId !== budget ||
    value.completeWorkflowCost !== false || value.issuerAuthenticated !== false || value.executionAuthorized !== false ||
    !["consistent", "countersConsistent", "attributionConsistent"].every(key => typeof value[key] === "boolean")) return false;
  for (const key of components) {
    const part = value[key];
    if (!shape(part, ["recorded", "settled", "pending", "recordedActualMicroUsd", "pendingReservedMicroUsd"]) ||
      !count(part.recorded) || !count(part.settled) || !count(part.pending) || part.recorded > 1024 ||
      part.recorded !== part.settled + part.pending || !amount(part.recordedActualMicroUsd) ||
      !amount(part.pendingReservedMicroUsd) ||
      (part.settled === 0 && part.recordedActualMicroUsd !== "0") ||
      (part.pending === 0 && part.pendingReservedMicroUsd !== "0")) return false;
  }
  const issues = value.issues;
  if (!shape(value.ledger, ["limitMicroUsd", "reservedMicroUsd", "spentMicroUsd", "overrunMicroUsd"]) ||
    !Object.values(value.ledger).every(amount) ||
    !shape(value.totals, ["recordedActualMicroUsd", "pendingReservedMicroUsd", "pendingComponents"]) ||
    !amount(value.totals.recordedActualMicroUsd) || !amount(value.totals.pendingReservedMicroUsd) || !count(value.totals.pendingComponents) ||
    !shape(value.difference, ["reservedMicroUsd", "chargedMicroUsd"]) ||
    !Object.values(value.difference).every(v => typeof v === "string" && signedDecimal.test(v)) ||
    !shape(issues, ["hasUnattributedRecords", "invalidSqlReceipts", "invalidAuxiliaryAudits", "invalidAuxiliaryBills"]) ||
    typeof issues.hasUnattributedRecords !== "boolean" ||
    !["invalidSqlReceipts", "invalidAuxiliaryAudits", "invalidAuxiliaryBills"].every(key => count(issues[key]))) return false;
  const report = value as BudgetReport;
  const actual = components.reduce((sum, key) => sum + BigInt(report[key].recordedActualMicroUsd), 0n);
  const held = components.reduce((sum, key) => sum + BigInt(report[key].pendingReservedMicroUsd), 0n);
  const ledger = report.ledger;
  const chargedDifference = actual - BigInt(ledger.spentMicroUsd) - BigInt(ledger.overrunMicroUsd);
  const heldDifference = held - BigInt(ledger.reservedMicroUsd);
  const counters = chargedDifference === 0n && heldDifference === 0n &&
    BigInt(ledger.spentMicroUsd) + BigInt(ledger.reservedMicroUsd) <= BigInt(ledger.limitMicroUsd);
  const attribution = !report.issues.hasUnattributedRecords && report.issues.invalidSqlReceipts === 0 &&
    report.issues.invalidAuxiliaryAudits === 0 && report.issues.invalidAuxiliaryBills === 0;
  return report.model.recorded + report.tool.recorded <= 1024 &&
    report.issues.invalidSqlReceipts <= report.sql.settled &&
    report.issues.invalidAuxiliaryAudits <= report.model.recorded + report.tool.recorded &&
    report.issues.invalidAuxiliaryBills <= report.model.settled + report.tool.settled &&
    report.totals.recordedActualMicroUsd === actual.toString() && report.totals.pendingReservedMicroUsd === held.toString() &&
    report.totals.pendingComponents === components.reduce((sum, key) => sum + report[key].pending, 0) &&
    report.difference.chargedMicroUsd === chargedDifference.toString() && report.difference.reservedMicroUsd === heldDifference.toString() &&
    report.countersConsistent === counters && report.attributionConsistent === attribution && report.consistent === (counters && attribution);
}

// Decimal strings stay exact even when aggregate amounts exceed safe JS integers.
export function formatMicroUsd(value: string) {
  if (!signedDecimal.test(value)) throw new Error("Invalid micro-USD amount");
  const negative = value.startsWith("-");
  const digits = (negative ? value.slice(1) : value).padStart(7, "0");
  return `${negative ? "-" : ""}$${digits.slice(0, -6).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${digits.slice(-6)}`;
}

export async function inspectBudget(tenant: string, budget: string, signal: AbortSignal, get: typeof fetch = fetch): Promise<BudgetInspection> {
  if (!routeId.test(tenant) || !routeId.test(budget)) return { state: "invalid" };
  try {
    const response = await get(gatewayPath("/api/control/") + tenant + "/budget-reconciliation/" + budget, {
      method: "GET", credentials: "same-origin", cache: "no-store", redirect: "error", signal
    });
    if (response.status === 401) return { state: "unauthenticated" };
    if (response.status === 403) return { state: "denied" };
    if (response.status === 503) {
      const body = await response.json();
      return { state: body?.ok === false && body.code === "budget_accounting_unavailable" ? "incompatible" : "unavailable" };
    }
    if (response.status !== 200) return { state: "unavailable" };
    const body = await response.json();
    if (body?.ok !== true || !validReport(body.reconciliation, tenant, budget)) return { state: "unavailable" };
    return { state: "ready", report: body.reconciliation };
  } catch { return { state: "unavailable" }; }
}
