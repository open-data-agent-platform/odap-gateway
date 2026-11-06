import { describe, expect, it, vi } from "vitest";
import { inspectOwnProposal, proposalHistory } from "../lib/request-inspection";

const base = { tenantId: "demo", id: "req", recordedState: "proposed", releaseId: "v1", requestedAgentId: "agent",
  actionDigest: "sha256:" + "1".repeat(64), requestedAt: "2020-01-01T00:00:00.000Z" };
const grant = { grantId: "grant-1", grantedAt: "2020-01-01T01:00:00.000Z", expiresAt: "2020-01-01T01:10:00.000Z" };
describe("requester grant history", () => {
  it("reads the opt-in view and projects only historical reference fields", async () => {
    const get = vi.fn(async () => Response.json({ ok: true, object: { ...base,
      grantReference: { ...grant, projectId: "private", active: true } } }));
    const signal = new AbortController().signal;
    expect(await inspectOwnProposal("demo", "req", signal, get)).toEqual({ state: "ready", snapshot: { ...base, grantReference: grant } });
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith("/api/control/demo/contract-request/req?view=grant-history", {
      method: "GET", credentials: "same-origin", cache: "no-store", redirect: "error", signal });
  });
  it("distinguishes an old response with no view from a completed lookup with no grant", () => {
    expect(proposalHistory(base, "demo", "req")).toEqual(base);
    const empty = { ...base, grantReference: null };
    expect(proposalHistory(empty, "demo", "req")).toEqual(empty);
  });
  it("rejects wrong scope, incomplete references and invalid validity windows", () => {
    for (const fields of [{ tenantId: "other" }, { id: "other" }, { grantReference: [] }, { grantReference: false },
      { grantReference: { grantId: "only" } }, { grantReference: { ...grant, grantId: "a/b" } },
      { grantReference: { ...grant, expiresAt: grant.grantedAt } }, { grantReference: { ...grant, expiresAt: "2099-01-01T01:10:00.000Z" } }]) {
      expect(proposalHistory({ ...base, grantReference: grant, ...fields }, "demo", "req")).toBeNull();
    }
  });
});
