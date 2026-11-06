import { isControlTimestamp } from "./control-objects";
import { inspectObject } from "./object-inspection";
import { validRequestId } from "./review-contract-request";

type Scope = { tenantId: string; grantId: string; requestId: string; agentId: string; expiresAt: string };
const id = (v: unknown): v is string => typeof v === "string" && validRequestId(v);
const time = (v: unknown): v is string => typeof v === "string" && isControlTimestamp(v);
export function delegationHistory(value: unknown, tenantId: string, grantId: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  if (r.tenantId !== tenantId || r.grantId !== grantId || !id(r.requestId) || !id(r.delegationId) ||
      !id(r.agentId) || !id(r.keyId) || !time(r.expiresAt) || !(r.verifiedAt === null || time(r.verifiedAt)) ||
      !(r.revokedAt === null || time(r.revokedAt))) return null;
  return { tenantId, grantId, requestId: r.requestId, delegationId: r.delegationId, agentId: r.agentId,
    keyId: r.keyId, expiresAt: r.expiresAt, verifiedAt: r.verifiedAt, revokedAt: r.revokedAt };
}

export function inspectOwnDelegation(scope: Scope, signal: AbortSignal, get: typeof fetch = fetch) {
  return inspectObject(scope.tenantId, scope.grantId, "grant-delegation", signal, get, value => {
    const d = delegationHistory(value, scope.tenantId, scope.grantId);
    return d && d.requestId === scope.requestId && d.agentId === scope.agentId && d.expiresAt === scope.expiresAt ? d : null;
  });
}
