import { describe, expect, it, vi } from "vitest";
import { canonicalControlJson } from "../lib/control-objects";
import { consentToDelegation } from "../lib/requester-delegation";

const signal = new AbortController().signal;
function trial() {
  const scope = { tenantId: "demo", requestId: "req", agentId: "reporter", releaseId: "rev", grantId: "g1",
    expiresAt: new Date(Date.now() + 600000).toISOString(), actionDigest: "sha256:" + "c".repeat(64) };
  const terms = { ...scope, delegationId: "d-1", keyId: "k1", audience: "gateway-demo", requesterId: "google:requester",
    purpose: "odap.gateway.contract-delegation-proof.v1", policyRevision: "p1", projectId: "demo", location: "US" };
  const ack = (challenge: string, extra = {}) => Response.json({ ok: true, delegation: { delegationId: terms.delegationId,
    expiresAt: terms.expiresAt, challenge, ...extra } });
  return { scope, terms, ack };
}
describe("requester delegation consent client", () => {
  it("sends only explicit consent and returns the exact canonical challenge", async () => {
    const { scope, terms, ack } = trial(), challenge = canonicalControlJson(terms);
    const post = vi.fn(async () => ack(challenge));
    expect(await consentToDelegation(scope, "k1", signal, post)).toEqual({ state: "recorded", delegationId: "d-1", challenge });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith("/api/control/demo/delegations", expect.objectContaining({ method: "POST",
      credentials: "same-origin", cache: "no-store", redirect: "error", body: JSON.stringify({ operation: "create", grantId: "g1", agentId: "reporter", keyId: "k1" }) }));
  });
  it("rejects swapped terms, an altered envelope and noncanonical signing bytes", async () => {
    const { scope, terms, ack } = trial(), challenge = canonicalControlJson(terms);
    for (const name of ["purpose", "tenantId", "grantId", "requestId", "agentId", "keyId", "releaseId", "actionDigest", "expiresAt", "delegationId"]) {
      const post = async () => ack(canonicalControlJson({ ...terms, [name]: "substituted" }));
      expect(await consentToDelegation(scope, "k1", signal, post)).toEqual({ state: "unknown" });
    }
    for (const res of [ack(challenge + " "), ack(canonicalControlJson({ ...terms, extra: true })), ack("{bad"),
      ack(challenge, { delegationId: "different" }), ack(challenge, { expiresAt: "2099" })]) {
      expect(await consentToDelegation(scope, "k1", signal, async () => res)).toEqual({ state: "unknown" });
    }
  });
  it("does not send expired references or invalid key and tenant IDs", async () => {
    const { scope } = trial(), post = vi.fn();
    expect(await consentToDelegation({ ...scope, expiresAt: "2000-01-01T12:10:00.000Z" }, "k1", signal, post)).toEqual({ state: "expired" });
    expect(await consentToDelegation(scope, " key", signal, post)).toEqual({ state: "invalid" });
    expect(await consentToDelegation({ ...scope, tenantId: "../peer" }, "k1", signal, post)).toEqual({ state: "invalid" });
    expect(post).not.toHaveBeenCalled();
  });
  it("does not turn an ambiguous acknowledgement into refusal or retry automatically", async () => {
    const { scope } = trial();
    for (const [status, code, state] of [[409, "delegation_unavailable", "refused"], [403, "tenant_access_denied", "refused"],
      [401, "unauthenticated", "refused"], [409, "unknown_conflict", "unknown"], [503, "control_storage_unavailable", "unknown"]] as const) {
      const post = vi.fn(async () => Response.json({ ok: false, code }, { status }));
      expect(await consentToDelegation(scope, "k1", signal, post)).toEqual({ state });
      expect(post).toHaveBeenCalledTimes(1);
    }
  });
});
