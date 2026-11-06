import { describe, expect, it, vi } from "vitest";
import { issueForReviewedDelegation } from "../lib/requester-contract-issuance";

const scope = { tenantId: "t", grantId: "g", requestId: "req", agentId: "reader", releaseId: "release",
  actionDigest: "sha256:" + "a".repeat(64), expiresAt: "2099-01-01T00:10:00.000Z" };
const d = { ...scope, keyId: "k", delegationId: "d", verifiedAt: "2026-01-01T00:00:00.000Z", revokedAt: null };
const c = { schemaVersion: "0.1", id: "c", tenantId: "t", semanticReleaseId: scope.releaseId, principalId: "google:requester",
  agentId: scope.agentId, actionDigest: scope.actionDigest, policyRevision: "p", sourceRevision: "s", target: "orders",
  actionType: "data.read", authority: { mode: "human", reference: "g" }, reservationId: "reserved-id", expiresAt: scope.expiresAt, state: "authorized" };
const accepted = { ok: true, issuance: { delegationId: "d", contractId: "c" } };
const path = "/api/control/t/contract/c";
const ack = (location = path, body: unknown = accepted) => Response.json(body, { status: 201, headers: { Location: location } });
const signal = new AbortController().signal;

describe("requester issuance after inspection", () => {
  it("never writes for an unproven, revoked, expired or mismatched delegation", async () => {
    const send = vi.fn();
    for (const change of [{ verifiedAt: null }, { revokedAt: d.verifiedAt }, { tenantId: "peer" }, { requestId: "other" },
      { agentId: "other" }, { grantId: "other" }, { expiresAt: "2000-01-01T00:00:00.000Z" }]) {
      expect(await issueForReviewedDelegation({ ...scope, expiresAt: change.expiresAt ?? scope.expiresAt }, { ...d, ...change }, signal, send))
        .toEqual({ state: "ineligible" });
    }
    expect(await issueForReviewedDelegation(scope, d, AbortSignal.abort(), send)).toEqual({ state: "unknown" });
    expect(send).not.toHaveBeenCalled();
  });
  it("distinguishes known refusal from ambiguity and never follows a substituted reference", async () => {
    for (const [reply, state] of [
      [Response.json({ ok: false, code: "contract_issuance_unavailable" }, { status: 409 }), "refused"],
      [Response.json({ ok: false, code: "unrelated" }, { status: 409 }), "unknown"],
      [ack("https://foreign.test" + path), "unknown"], [ack("/api/control/peer/contract/c"), "unknown"],
      [ack(path, { ok: true, issuance: { delegationId: "other", contractId: "c" } }), "unknown"],
      [ack(path, { ok: true, issuance: { delegationId: "d", contractId: "../x" } }), "unknown"]
    ] as const) {
      const send = vi.fn(async () => reply);
      expect(await issueForReviewedDelegation(scope, d, signal, send)).toEqual({ state });
      expect(send).toHaveBeenCalledTimes(1);
    }
  });
  it("only exposes a stored contract bound to the original grant, agent, release, action and expiry", async () => {
    for (const swap of [{ id: "other" }, { tenantId: "peer" }, { authority: { mode: "human", reference: "other" } },
      { authority: { mode: "policy", reference: "g" } }, { agentId: "other" }, { semanticReleaseId: "other" },
      { actionDigest: "sha256:" + "b".repeat(64) }, { expiresAt: "2099-01-01T00:11:00.000Z" }, { state: "revoked" }]) {
      const send = vi.fn<typeof fetch>().mockResolvedValueOnce(ack()).mockResolvedValueOnce(Response.json({ ok: true, object: { ...c, ...swap } }));
      expect(await issueForReviewedDelegation(scope, d, signal, send)).toEqual(swap.state === "revoked"
        ? { state: "recorded", contractId: "c", contractState: "revoked" } : { state: "unknown" });
      expect(send.mock.calls.map(([u, i]) => [u, i?.method])).toEqual([["/api/control/t/contract-issuances", "POST"], [path, "GET"]]);
    }
  });
});
