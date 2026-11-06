import { isControlTimestamp } from "./control-objects";
import { inspectObject } from "./object-inspection";
import { validRequestId } from "./review-contract-request";

export type BudgetScope = { tenantId: string; contractId: string; delegationId: string; actionDigest: string; expiresAt: string };
const id = (v: unknown): v is string => typeof v === "string" && validRequestId(v);

export function budgetQuote(value: unknown, tenantId: string, contractId: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const q = value as Record<string, unknown>;
  if (!id(tenantId) || !id(contractId) || q.tenantId !== tenantId || q.contractId !== contractId || !id(q.delegationId) ||
      typeof q.budgetId !== "string" || !q.budgetId.trim() || typeof q.microUsd !== "number" || !Number.isSafeInteger(q.microUsd) ||
      q.microUsd < 1 || typeof q.actionDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(q.actionDigest) ||
      typeof q.expiresAt !== "string" || !isControlTimestamp(q.expiresAt)) return null;
  return { tenantId, contractId, delegationId: q.delegationId, actionDigest: q.actionDigest, expiresAt: q.expiresAt,
    budgetId: q.budgetId, microUsd: q.microUsd };
}

function matchingQuote(value: unknown, { tenantId, contractId, delegationId, actionDigest, expiresAt }: BudgetScope) {
  const q = budgetQuote(value, tenantId, contractId);
  return q && q.delegationId === delegationId && q.actionDigest === actionDigest && q.expiresAt === expiresAt &&
    Date.parse(q.expiresAt) > Date.now() ? q : null;
}

export function inspectBudgetQuote(scope: BudgetScope, signal: AbortSignal, get: typeof fetch = fetch) {
  const pinned = { ...scope };
  return inspectObject(pinned.tenantId, pinned.contractId, "budget-quote", signal, get, value => matchingQuote(value, pinned));
}

type Admission = { state: "acknowledged"; intentId: string; replay: boolean } | { state: "invalid" | "refused" | "unknown" };
export async function confirmBudgetReservation(scope: BudgetScope, quote: NonNullable<ReturnType<typeof budgetQuote>>,
  signal: AbortSignal, post: typeof fetch = fetch): Promise<Admission> {
  const q = matchingQuote(quote, scope);
  if (!q || signal.aborted) return { state: "invalid" };
  try {
    const res = await post("/api/control/" + q.tenantId + "/budget-admissions", {
      method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contractId: q.contractId }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(15000)])
    });
    const b = await res.json();
    if (b?.ok === false && ((res.status === 409 && b.code === "budget_admission_unavailable") ||
      (res.status === 403 && ["tenant_access_denied", "same_origin_required"].includes(b.code)) ||
      (res.status === 401 && b.code === "unauthenticated"))) return { state: "refused" };
    if ([200, 201].includes(res.status) && b?.ok === true && b.admission?.contractId === q.contractId && id(b.admission.intentId))
      return { state: "acknowledged", intentId: b.admission.intentId, replay: res.status === 200 };
  } catch { /* A lost reply is not a refusal. Do not replay a budget write here. */ }
  return { state: "unknown" };
}
