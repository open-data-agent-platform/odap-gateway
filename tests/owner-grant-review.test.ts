import { describe, expect, it, vi } from "vitest";
import { canonicalControlJson, sha256Text } from "../lib/control-objects";
import { checkOwnerReview } from "../lib/owner-grant-review";

const ids = { requesterId: "google:requester", requestId: "r1", requestedAgentId: "reader", policyRevision: "p1" };
const action = { profile: "odap.metric-read.v1", target: "orders", metricId: "total", parameters: { paid: false, year: 0 } };
const signal = new AbortController().signal;
describe("owner grant review client", () => {
  it("posts only review terms and checks the canonical action digest", async () => {
    const review = { tenantId: "demo", releaseId: "v1", ...ids, state: "matched", reviewedBy: "google:owner",
      actionDigest: await sha256Text(canonicalControlJson(action)) };
    const post = vi.fn(async () => Response.json({ ok: true, review }));
    expect(await checkOwnerReview("demo", "v1", ids, action, signal, post)).toEqual({ state: "matched",
      match: { ...ids, tenantId: "demo", releaseId: "v1", reviewedBy: "google:owner", actionDigest: review.actionDigest, reviewedAction: action } });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith("/api/control/demo/human-grant-reviews", expect.objectContaining({ method: "POST",
      credentials: "same-origin", cache: "no-store", redirect: "error", body: JSON.stringify({ ...ids, releaseId: "v1", reviewedAction: action }) }));
    for (const key of Object.keys(review)) {
      const other = async () => Response.json({ ok: true, review: { ...review, [key]: key === "reviewedBy" ? ids.requesterId : "different" } });
      expect(await checkOwnerReview("demo", "v1", ids, action, signal, other)).toEqual({ state: "unavailable" });
    }
  });
  it("rejects invalid identifiers without sending review terms", async () => {
    const post = vi.fn();
    for (const override of [{ requesterId: "" }, { policyRevision: " p1" }, { requestId: "a/b" }, { requestedAgentId: "x".repeat(129) }]) {
      expect(await checkOwnerReview("demo", "v1", { ...ids, ...override }, action, signal, post)).toEqual({ state: "invalid" });
    }
    expect(post).not.toHaveBeenCalled();
  });
  it.each([[401, "unauthenticated", "signedOut"], [403, "human_grant_review_denied", "denied"],
    [403, "tenant_access_denied", "denied"], [404, "grant_review_unavailable", "noMatch"], [404, "not_found", "unavailable"],
    [413, "human_grant_review_too_large", "tooLarge"], [503, "control_storage_unavailable", "unavailable"]] as const)(
    "handles %s with code %s as %s, never retrying a write", async (status, code, state) => {
      const post = vi.fn(async () => Response.json({ ok: false, code }, { status }));
      expect(await checkOwnerReview("demo", "v1", ids, action, signal, post)).toEqual({ state });
      expect(post).toHaveBeenCalledOnce();
    });
});
