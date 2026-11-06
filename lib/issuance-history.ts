import { inspectObject } from "./object-inspection";
import { validRequestId } from "./review-contract-request";

type Scope = { tenantId: string; delegationId: string; requestId: string; grantId: string };
const id = (v: unknown): v is string => typeof v === "string" && validRequestId(v);

export function issuanceReference(value: unknown, tenantId: string, delegationId: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  if (r.tenantId !== tenantId || r.delegationId !== delegationId || !id(r.grantId) || !id(r.requestId) || !id(r.contractId)) return null;
  return { tenantId, delegationId, grantId: r.grantId, requestId: r.requestId, contractId: r.contractId };
}

export function inspectOwnIssuance({ tenantId, delegationId, requestId, grantId }: Scope, signal: AbortSignal, get: typeof fetch = fetch) {
  return inspectObject(tenantId, delegationId, "delegation-issuance", signal, get, value => {
    const ref = issuanceReference(value, tenantId, delegationId);
    return ref?.grantId === grantId && ref.requestId === requestId ? ref : null;
  });
}
