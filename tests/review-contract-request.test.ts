import { describe, expect, it, vi } from "vitest";
import { proposeMetricRequest } from "../lib/review-contract-request";
import { canonicalControlJson, sha256Text } from "../lib/control-objects";

const draft = { requestId: "r1", releaseId: "m1", requestedAgentId: "reporter", action: {
  profile: "odap.metric-read.v1", target: "orders", metricId: "revenue", parameters: { year: 2026 } } };
const signal = new AbortController().signal;
describe("contract proposal client", () => {
  it.each([{ requestId: "r2" }, { releaseId: "m2" }, { requestedAgentId: "other" }, { state: "authorized" },
    { actionDigest: "sha256:wrong" }, { requestedAt: "invalid" }])("does not accept a mismatched acknowledgement: %o", async override => {
    const request = { ...draft, actionDigest: await sha256Text(canonicalControlJson(draft.action)), state: "proposed",
      requestedAt: "2026-11-06T00:00:00.000Z", ...override };
    const post = vi.fn().mockResolvedValue(Response.json({ ok: true, request }, { status: 201 }));
    expect(await proposeMetricRequest("tenant", draft, signal, post)).toBe("unknown");
    expect(post).toHaveBeenCalledOnce();
    expect(post).toHaveBeenCalledWith("/api/control/tenant/contract-requests", expect.objectContaining({
      credentials: "same-origin", redirect: "error", method: "POST", body: JSON.stringify(draft) }));
  });
  it("does not send an invalid ID or mistake an ambiguous storage failure for refusal", async () => {
    const post = vi.fn().mockResolvedValue(Response.json({ ok: false, code: "control_storage_unavailable" }, { status: 503 }));
    expect(await proposeMetricRequest("t", { ...draft, requestedAgentId: "not/an/id" }, signal, post)).toBe("refused");
    expect(post).not.toHaveBeenCalled();
    expect(await proposeMetricRequest("t", draft, signal, post)).toBe("unknown");
    expect(post).toHaveBeenCalledOnce();
  });
});
