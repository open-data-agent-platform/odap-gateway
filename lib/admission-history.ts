import { inspectObject } from "./object-inspection";
import { validRequestId } from "./review-contract-request";

type Scope = { tenantId: string; contractId: string; delegationId: string; actionDigest: string };
const id = (v: unknown): v is string => typeof v === "string" && validRequestId(v);

export function admissionHistory(value: unknown, tenantId: string, contractId: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  if (r.tenantId !== tenantId || r.contractId !== contractId || !id(r.delegationId) || !id(r.intentId) ||
      typeof r.actionDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(r.actionDigest) ||
      typeof r.budgetId !== "string" || !r.budgetId.trim() || typeof r.originalMicroUsd !== "number" ||
      !Number.isSafeInteger(r.originalMicroUsd) || r.originalMicroUsd < 1) return null;
  return { tenantId, contractId, delegationId: r.delegationId, actionDigest: r.actionDigest, intentId: r.intentId,
    budgetId: r.budgetId, originalMicroUsd: r.originalMicroUsd };
}

export function inspectOwnAdmission({ tenantId, contractId, delegationId, actionDigest }: Scope,
  signal: AbortSignal, get: typeof fetch = fetch) {
  return inspectObject(tenantId, contractId, "contract-admission", signal, get, value => {
    const record = admissionHistory(value, tenantId, contractId);
    return record && record.delegationId === delegationId && record.actionDigest === actionDigest ? record : null;
  });
}
