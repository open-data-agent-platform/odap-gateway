import { describe, expect, it } from "vitest";
import { isApprovalContract, isEvidenceReceipt, isSemanticRelease, evaluateUntrustedExecution } from "../lib/control-objects";

const header = { schemaVersion: "0.1", id: "id", tenantId: "tenant" };
const release = { ...header, definitionDigest: "digest", sourceRevision: "s1", owner: "owner", state: "released" };
const contract = { ...header, semanticReleaseId: "id", principalId: "u", agentId: "a", actionDigest: "q",
  policyRevision: "p", sourceRevision: "s1", target: "demo.orders", reservationId: "r",
  expiresAt: "2026-11-06T00:00:00.000Z", actionType: "data.read", state: "authorized",
  authority: { mode: "policy", reference: "rule1" } };
const context = { tenantId: "tenant", principalId: "u", agentId: "a", actionDigest: "q",
  policyRevision: "p", sourceRevision: "s1", target: "demo.orders", reservationId: "r",
  now: Date.parse("2026-11-05T00:00:00Z"), permissionGranted: true, reservationActive: true };

describe("untrusted control object boundary", () => {
  it("accepts valid JSON objects and rejects unknown fields and versions", () => {
    expect(evaluateUntrustedExecution(release, contract, context).allowed).toBe(true);
    expect(isSemanticRelease({ ...release, tenant: "other" })).toBe(false);
    expect(isSemanticRelease({ ...release, schemaVersion: "0.2" })).toBe(false);
    expect(isApprovalContract({ ...contract, authority: { ...contract.authority, bypass: true } })).toBe(false);
  });
  it("rejects every omitted contract field", () => {
    for (const field of Object.keys(contract)) {
      const partial: Record<string, unknown> = { ...contract };
      delete partial[field];
      expect(isApprovalContract(partial)).toBe(false);
    }
  });
  it("rejects malformed JSON values without throwing", () => {
    for (const bad of [null, [], 1, true, "x", {}, { id: 4 }]) {
      expect(evaluateUntrustedExecution(bad, bad, bad)).toEqual({ allowed: false, reason: "invalid_wire_object" });
    }
    expect(evaluateUntrustedExecution(release, contract, { ...context, permissionGranted: "true" }).allowed).toBe(false);
  });
  it("requires canonical UTC timestamps and rejects impossible dates", () => {
    for (const expiresAt of ["2026-02-30T00:00:00.000Z", "tomorrow", "2026-11-06", "2026-11-06T00:00:00+00:00"]) {
      expect(isApprovalContract({ ...contract, expiresAt })).toBe(false);
    }
  });
  it("requires explicit missing references only for denied receipts", () => {
    const receipt = { ...header, intentId: "intent", reason: "not authorized", recordedAt: "2026-11-05T00:00:00.000Z",
      outcome: "denied", contractId: null, semanticReleaseId: null };
    expect(isEvidenceReceipt(receipt)).toBe(true);
    expect(isEvidenceReceipt({ ...receipt, outcome: "succeeded" })).toBe(false);
    expect(isEvidenceReceipt({ ...receipt, contractId: undefined })).toBe(false);
  });
});
