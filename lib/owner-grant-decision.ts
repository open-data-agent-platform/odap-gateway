import { gatewayPath } from "./gateway-path";
import { canonicalControlJson, isControlTimestamp, sha256Text } from "./control-objects";
import type { MatchedRequest } from "./owner-grant-review";
import { validRequestId } from "./review-contract-request";

export type GrantResult = { state: "recorded"; grantId: string; expiresAt: string }
  | { state: "unknown" | "refused" | "expired" };

export async function grantMatchedRequest(match: MatchedRequest, signal: AbortSignal, post: typeof fetch = fetch): Promise<GrantResult> {
  const { tenantId, reviewedBy, actionDigest, reviewedAction, ...terms } = match;
  if (!validRequestId(tenantId)) return { state: "refused" };
  try {
    // Retries after reinspection use the same ID without storing private inputs in the browser.
    const key = await sha256Text(canonicalControlJson({ tenantId, reviewedBy, actionDigest, ...terms }));
    const grantId = "g-" + key.slice("sha256:".length);
    const body = JSON.stringify({ grantId, ...terms, reviewedAction });
    if (await sha256Text(canonicalControlJson(JSON.parse(body).reviewedAction)) !== actionDigest) return { state: "refused" };
    signal.throwIfAborted();
    const res = await post(gatewayPath("/api/control/") + tenantId + "/human-grants", { method: "POST", body, credentials: "same-origin",
      cache: "no-store", redirect: "error", headers: { "Content-Type": "application/json" },
      signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) });
    const b = await res.json();
    if (b?.ok === false && ((res.status === 409 && b.code === "human_grant_not_recorded") ||
        (res.status === 401 && b.code === "unauthenticated") ||
        (res.status === 403 && ["tenant_access_denied", "human_grant_denied", "same_origin_required"].includes(b.code)))) {
      return { state: "refused" };
    }
    const g = b?.grant;
    if ((res.status === 200 || res.status === 201) && b?.ok === true && g?.grantId === grantId &&
        g.tenantId === tenantId && g.grantedBy === reviewedBy && g.actionDigest === actionDigest &&
        Object.entries(terms).every(([k, v]) => g[k] === v) && isControlTimestamp(g.grantedAt) &&
        isControlTimestamp(g.expiresAt) && Date.parse(g.expiresAt) - Date.parse(g.grantedAt) === 600_000) {
      return Date.parse(g.expiresAt) <= Date.now() ? { state: "expired" } : { state: "recorded", grantId, expiresAt: g.expiresAt };
    }
  } catch { /* A lost or invalid acknowledgement does not mean the write failed. */ }
  return { state: "unknown" };
}
