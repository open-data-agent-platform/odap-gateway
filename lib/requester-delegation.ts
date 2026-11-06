import { canonicalControlJson, isControlTimestamp } from "./control-objects";
import { validRequestId } from "./review-contract-request";

export type ConsentScope = { tenantId: string; requestId: string; grantId: string; agentId: string;
  releaseId: string; actionDigest: string; expiresAt: string };
export type ConsentResult = { state: "recorded"; delegationId: string; challenge: string } |
  { state: "expired" | "invalid" | "refused" | "unknown" };
const id = (v: unknown): v is string => typeof v === "string" && validRequestId(v);
const label = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v === v.trim();

export async function consentToDelegation(scope: ConsentScope, keyId: string, signal: AbortSignal,
  post: typeof fetch = fetch): Promise<ConsentResult> {
  const { tenantId, requestId, releaseId, grantId, agentId, expiresAt, actionDigest } = scope;
  if (![tenantId, requestId, releaseId, grantId, agentId, keyId].every(id) ||
      !isControlTimestamp(expiresAt) || !/^sha256:[0-9a-f]{64}$/.test(actionDigest)) return { state: "invalid" };
  if (Date.parse(expiresAt) <= Date.now()) return { state: "expired" };
  try {
    const res = await post("/api/control/" + tenantId + "/delegations", { method: "POST", credentials: "same-origin",
      cache: "no-store", redirect: "error", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operation: "create", grantId, agentId, keyId }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) });
    const b = await res.json();
    if (b?.ok === false && ((res.status === 409 && b.code === "delegation_unavailable") ||
        (res.status === 401 && b.code === "unauthenticated") ||
        (res.status === 403 && ["tenant_access_denied", "same_origin_required"].includes(b.code)))) return { state: "refused" };
    const d = b?.delegation;
    if (res.status !== 200 || b?.ok !== true || !id(d?.delegationId) || d.expiresAt !== expiresAt ||
        typeof d.challenge !== "string") return { state: "unknown" };
    // Preserve the exact signing bytes; reject extra, substituted or noncanonical terms.
    const { audience, requesterId, policyRevision, projectId, location } = JSON.parse(d.challenge);
    if (!id(audience) || ![requesterId, policyRevision, projectId, location].every(label) ||
        canonicalControlJson({ purpose: "odap.gateway.contract-delegation-proof.v1", audience, tenantId,
          delegationId: d.delegationId, grantId, requesterId, requestId, agentId, keyId, releaseId, actionDigest,
          policyRevision, projectId, location, expiresAt }) !== d.challenge) return { state: "unknown" };
    return Date.parse(expiresAt) <= Date.now() ? { state: "expired" } :
      { state: "recorded", delegationId: d.delegationId, challenge: d.challenge };
  } catch { return { state: "unknown" }; }
}
