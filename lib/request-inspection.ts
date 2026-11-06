import { isControlTimestamp } from "./control-objects";
import { inspectObject } from "./object-inspection";

const scopedId = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v);
type GrantReference = { grantId: string; grantedAt: string; expiresAt: string };
function grantHistory(value: unknown): GrantReference | null | undefined {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { grantId, grantedAt, expiresAt } = value as Record<string, unknown>;
  if (!scopedId(grantId) || typeof grantedAt !== "string" || !isControlTimestamp(grantedAt) ||
      typeof expiresAt !== "string" || !isControlTimestamp(expiresAt) ||
      Date.parse(expiresAt) - Date.parse(grantedAt) !== 600_000) return undefined;
  return { grantId, grantedAt, expiresAt };
}
export function proposalHistory(value: unknown, tenantId: string, id: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  if (r.tenantId !== tenantId || r.id !== id || r.recordedState !== "proposed" ||
      !scopedId(r.releaseId) || !scopedId(r.requestedAgentId) || typeof r.actionDigest !== "string" ||
      !/^sha256:[0-9a-f]{64}$/.test(r.actionDigest) || typeof r.requestedAt !== "string" || !isControlTimestamp(r.requestedAt)) return null;
  const grantReference = grantHistory(r.grantReference);
  if (Object.hasOwn(r, "grantReference") && grantReference === undefined) return null;
  return { tenantId, id, recordedState: "proposed" as const, releaseId: r.releaseId, requestedAgentId: r.requestedAgentId,
    actionDigest: r.actionDigest, requestedAt: r.requestedAt, ...(grantReference === undefined ? {} : { grantReference }) };
}

export function inspectOwnProposal(tenantId: string, id: string, signal: AbortSignal, get: typeof fetch = fetch) {
  return inspectObject(tenantId, id, "contract-request", signal, get, value => proposalHistory(value, tenantId, id));
}
