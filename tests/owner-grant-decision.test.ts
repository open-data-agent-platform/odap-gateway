import { describe, expect, it, vi } from "vitest";
import { canonicalControlJson, sha256Text } from "../lib/control-objects";
import { grantMatchedRequest } from "../lib/owner-grant-decision";

const reviewedAction = { profile: "odap.metric-read.v1", metricId: "revenue", target: "orders", parameters: { paid: false, year: 0 } };
const ids = { requesterId: "reader", requestId: "request", requestedAgentId: "agent", releaseId: "release", policyRevision: "p1" };
const makeMatch = async () => ({ ...ids, reviewedAction, reviewedBy: "owner", tenantId: "demo", actionDigest: await sha256Text(canonicalControlJson(reviewedAction)) });
const signal = new AbortController().signal;
describe("owner grant decision client", () => {
  async function tryAck(override: Record<string, unknown> = {}) {
    const match = await makeMatch(), now = Date.now();
    const post = vi.fn(async (_: RequestInfo | URL, init?: RequestInit) => {
      const input = JSON.parse(String(init?.body));
      expect(input).toEqual({ ...ids, reviewedAction, grantId: expect.stringMatching(/^g-[a-f0-9]{64}$/) });
      return Response.json({ ok: true, grant: { ...ids, grantId: input.grantId, tenantId: "demo", grantedBy: "owner",
        actionDigest: match.actionDigest, grantedAt: new Date(now).toISOString(), expiresAt: new Date(now + 600000).toISOString(), ...override } });
    });
    const result = await grantMatchedRequest(match, signal, post);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith("/api/control/demo/human-grants", expect.objectContaining({
      method: "POST", credentials: "same-origin", redirect: "error", cache: "no-store" }));
    return result;
  }
  it("confirms only this owner, tenant, grant and exact matched action", async () => {
    expect(await tryAck()).toMatchObject({ state: "recorded" });
    for (const field of [...Object.keys(ids), "grantId", "grantedBy", "tenantId", "actionDigest", "expiresAt", "grantedAt"]) {
      expect(await tryAck({ [field]: "other" })).toEqual({ state: "unknown" });
    }
  });
  it("distinguishes expired acknowledgements from malformed validity intervals", async () => {
    const earlier = "2000-01-01T00:00:00.000Z", later = "2000-01-01T00:10:00.000Z";
    expect(await tryAck({ grantedAt: earlier, expiresAt: later })).toEqual({ state: "expired" });
    expect(await tryAck({ grantedAt: later, expiresAt: earlier })).toEqual({ state: "unknown" });
    expect(await tryAck({ grantedAt: earlier, expiresAt: "2099-01-01T00:00:00.000Z" })).toEqual({ state: "unknown" });
  });
  it("does not transmit a mutated action or an abandoned review", async () => {
    const match = await makeMatch(), post = vi.fn();
    expect(await grantMatchedRequest({ ...match, reviewedAction: { ...reviewedAction, parameters: { year: 1 } } }, signal, post)).toEqual({ state: "refused" });
    expect(await grantMatchedRequest(match, AbortSignal.abort(), post)).toEqual({ state: "unknown" });
    expect(post).not.toHaveBeenCalled();
  });
});
