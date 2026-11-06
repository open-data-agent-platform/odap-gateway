import { describe, expect, it } from "vitest";
import { canonicalControlJson, sha256Text } from "../lib/control-objects";
import { delegatedSettledEvidenceProfile, verifySettledEvidence } from "../lib/settled-evidence";
import fixture from "./fixtures/settled-job.json";

const scope = { tenantId: "t", intentId: "i" };
const times = [0, 1, 2, 3].map(second => `2026-01-01T00:00:0${second}.000Z`);
function evidence(delegated: boolean) {
  const data = structuredClone(fixture);
  if (!delegated) return data;
  return { ...data, profile: delegatedSettledEvidenceProfile, delegation: {
    admissionAudience: "gateway", claimAudience: "gateway", observedAudience: "gateway", billedAudience: "gateway",
    claimDigest: "sha256:" + "a".repeat(64), observedDigest: "sha256:" + "a".repeat(64),
    billedDigest: "sha256:" + "a".repeat(64), billedProject: data.job.projectId, billedLocation: data.job.location
  } };
}

describe.each([false, true])("settled evidence chronology, delegated=%s", delegated => {
  const expectedScope = { ...scope, ...(delegated && { audience: "gateway" }) };
  it.each(["pending after claim", "observation before claim", "bill before observation",
    "claim at expiry", "claim after expiry"])("rejects %s even with a matching checksum", async scenario => {
    const data = evidence(delegated);
    if (scenario === "pending after claim") data.pending.recordedAt = times[2];
    if (scenario === "observation before claim") data.observation.observedAt = times[0];
    if (scenario === "bill before observation") data.bill.recordedAt = data.final.recordedAt = times[1];
    if (scenario === "claim at expiry") data.contract.expiresAt = times[1];
    if (scenario === "claim after expiry") data.contract.expiresAt = times[0];
    const json = canonicalControlJson(data);
    await expect(verifySettledEvidence(json, expectedScope, await sha256Text(json)))
      .rejects.toThrow("Invalid evidence chronology");
  });

  it("accepts equal record timestamps without inventing finer clock precision", async () => {
    const data = evidence(delegated);
    data.pending.recordedAt = data.job.claimedAt = data.observation.observedAt =
      data.bill.recordedAt = data.final.recordedAt = times[0];
    data.contract.expiresAt = "2026-01-01T00:00:00.001Z";
    const json = canonicalControlJson(data);
    expect(await verifySettledEvidence(json, expectedScope, await sha256Text(json)))
      .toMatchObject({ consistent: true, issuerAuthenticated: false });
  });

  it("accepts observation and billing after expiry for an earlier eligible claim", async () => {
    const data = evidence(delegated);
    data.contract.expiresAt = "2026-01-01T00:00:01.001Z";
    const json = canonicalControlJson(data);
    expect(await verifySettledEvidence(json, expectedScope, await sha256Text(json)))
      .toMatchObject({ consistent: true, issuerAuthenticated: false });
  });

  it("preserves the existing ordered bundle and does not authenticate its clock", async () => {
    const json = canonicalControlJson(evidence(delegated));
    expect(await verifySettledEvidence(json, expectedScope, await sha256Text(json)))
      .toMatchObject({ consistent: true, issuerAuthenticated: false });
  });
});
