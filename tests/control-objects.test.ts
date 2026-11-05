import { describe, expect, it } from "vitest";
import { canonicalControlJson, evaluateExecutionContract, validateEvidenceReceipt,
  type SemanticRelease, type ApprovalContract, type ExecutionContext } from "../lib/control-objects";

const release: SemanticRelease = { schemaVersion: "0.1", id: "release-1", tenantId: "t1",
  definitionDigest: "digest-1", sourceRevision: "s1", owner: "finance", state: "released" };
const contract: ApprovalContract = { schemaVersion: "0.1", id: "contract-1", tenantId: "t1",
  semanticReleaseId: "release-1", principalId: "u1", agentId: "a1", actionDigest: "q1",
  policyRevision: "p1", sourceRevision: "s1", target: "demo.orders", actionType: "data.read",
  authority: { mode: "human", reference: "review-1" }, reservationId: "budget-1",
  expiresAt: "2026-11-06T00:00:00Z", state: "authorized" };
const context: ExecutionContext = { tenantId: "t1", principalId: "u1", agentId: "a1",
  actionDigest: "q1", policyRevision: "p1", sourceRevision: "s1", target: "demo.orders",
  reservationId: "budget-1", now: Date.parse("2026-11-05T00:00:00Z"),
  permissionGranted: true, reservationActive: true };

describe("draft control object contracts", () => {
  it("accepts an eligible read and rejects every changed bound context field", () => {
    expect(evaluateExecutionContract(release, contract, context).allowed).toBe(true);
    for (const key of ["tenantId", "principalId", "agentId", "actionDigest", "policyRevision", "sourceRevision", "target", "reservationId"] as const) {
      expect(evaluateExecutionContract(release, contract, { ...context, [key]: "changed" }).allowed).toBe(false);
    }
  });
  it("rejects revoked releases, consumed contracts, expired authority and withdrawn rights", () => {
    expect(evaluateExecutionContract({ ...release, state: "revoked" }, contract, context).allowed).toBe(false);
    expect(evaluateExecutionContract(release, { ...contract, state: "consumed" }, context).allowed).toBe(false);
    expect(evaluateExecutionContract(release, contract, { ...context, now: Date.parse(contract.expiresAt) }).allowed).toBe(false);
    expect(evaluateExecutionContract(release, contract, { ...context, permissionGranted: false }).allowed).toBe(false);
    expect(evaluateExecutionContract(release, contract, { ...context, reservationActive: false }).allowed).toBe(false);
  });
  it("fails closed on unknown versions, invalid time and missing authority", () => {
    expect(evaluateExecutionContract(release, { ...contract, schemaVersion: "2" } as unknown as ApprovalContract, context).allowed).toBe(false);
    expect(evaluateExecutionContract(release, contract, { ...context, now: NaN }).allowed).toBe(false);
    expect(evaluateExecutionContract(release, { ...contract, authority: { mode: "human", reference: "" } }, context).allowed).toBe(false);
  });
  it("allows denial evidence without fabricated authority, but requires links for execution", () => {
    const receipt = { schemaVersion: "0.1" as const, id: "r1", tenantId: "t1", intentId: "i1",
      contractId: null, semanticReleaseId: null, outcome: "denied" as const,
      reason: "permission_denied", recordedAt: "2026-11-05T00:00:00Z" };
    expect(validateEvidenceReceipt(receipt)).toBe(true);
    expect(validateEvidenceReceipt({ ...receipt, outcome: "succeeded" })).toBe(false);
  });
  it("canonicalizes nested keys and rejects ambiguous or non-JSON values", () => {
    expect(canonicalControlJson({ b: 2, a: { z: 1, c: "x" } })).toBe('{"a":{"c":"x","z":1},"b":2}');
    for (const value of [undefined, NaN, Infinity, -0, 1.1, new Date(), { a: undefined }, Array(1)]) {
      expect(() => canonicalControlJson(value)).toThrow();
    }
  });
});
