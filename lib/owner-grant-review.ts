import { gatewayPath } from "./gateway-path";
import { canonicalControlJson, sha256Text } from "./control-objects";
import { validRequestId, type MetricAction } from "./review-contract-request";

export type ReviewIds = { requesterId: string; requestId: string; requestedAgentId: string; policyRevision: string };
type ReviewState = "noMatch" | "signedOut" | "denied" | "invalid" | "tooLarge" | "unavailable";
export type MatchedRequest = ReviewIds & { tenantId: string; releaseId: string; reviewedBy: string; actionDigest: string; reviewedAction: MetricAction };
type ReviewResult = { state: ReviewState } | { state: "matched"; match: MatchedRequest };
export function validReviewIds(ids: ReviewIds) {
  const label = (s: string) => !!s && s === s.trim() && s.length <= 256;
  return validRequestId(ids.requestId) && validRequestId(ids.requestedAgentId) && label(ids.requesterId) && label(ids.policyRevision);
}
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

export async function checkOwnerReview(tenantId: string, releaseId: string, ids: ReviewIds, reviewedAction: MetricAction,
  signal: AbortSignal, post: typeof fetch = fetch): Promise<ReviewResult> {
  if (!validRequestId(tenantId) || !validRequestId(releaseId) || !validReviewIds(ids)) return { state: "invalid" };
  try {
    const { requesterId, requestId, requestedAgentId, policyRevision } = ids;
    const body = JSON.stringify({ requesterId, requestId, requestedAgentId, policyRevision, releaseId, reviewedAction });
    const snapshot = JSON.parse(body) as ReviewIds & { releaseId: string; reviewedAction: MetricAction };
    const actionDigest = await sha256Text(canonicalControlJson(snapshot.reviewedAction));
    const res = await post(gatewayPath("/api/control/") + tenantId + "/human-grant-reviews", { method: "POST", body,
      credentials: "same-origin", cache: "no-store", redirect: "error", headers: { "Content-Type": "application/json" },
      signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) });
    const b: unknown = await res.json();
    if (record(b) && b.ok === false) {
      if (res.status === 404 && b.code === "grant_review_unavailable") return { state: "noMatch" };
      if (res.status === 401 && b.code === "unauthenticated") return { state: "signedOut" };
      if (res.status === 403 && (b.code === "tenant_access_denied" || b.code === "human_grant_review_denied")) return { state: "denied" };
      if (res.status === 413 && b.code === "human_grant_review_too_large") return { state: "tooLarge" };
    }
    const r = record(b) && b.ok === true ? b.review : null;
    if (res.status === 200 && record(r) && r.state === "matched" && r.tenantId === tenantId && r.releaseId === releaseId &&
        r.requesterId === requesterId && r.requestId === requestId && r.requestedAgentId === requestedAgentId &&
        r.policyRevision === policyRevision && r.actionDigest === actionDigest && typeof r.reviewedBy === "string" &&
        r.reviewedBy.trim() === r.reviewedBy && r.reviewedBy !== "" && r.reviewedBy !== requesterId) {
      return { state: "matched", match: { ...snapshot, tenantId, actionDigest, reviewedBy: r.reviewedBy } };
    }
  } catch { /* Only a fully verified response confirms a match. */ }
  return { state: "unavailable" };
}
