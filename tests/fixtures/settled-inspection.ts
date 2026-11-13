import sample from "./settled-job.json";
import { canonicalControlJson, sha256Text } from "../../lib/control-objects";
import { delegatedSettledEvidenceProfile } from "../../lib/settled-evidence";

export async function settledInspectionFixture(outcome: "succeeded" | "failed" | "cancelled" = "succeeded", amount = 12) {
  const audience = "test-gateway", claimDigest = "sha256:"+"f".repeat(64);
  const data = { ...structuredClone(sample), profile: delegatedSettledEvidenceProfile, delegation: {
    admissionAudience: audience, claimAudience: audience, claimDigest,
    observedAudience: audience, observedDigest: claimDigest, billedAudience: audience, billedDigest: claimDigest,
    billedProject: sample.job.projectId, billedLocation: sample.job.location
  } };
  data.final.outcome = data.observation.outcome = outcome;
  data.bill.actualMicroUsd = data.settlement.actualMicroUsd = amount;
  const json = canonicalControlJson(data), digest = await sha256Text(json);
  return { data, body: { ok: true, evidence: { tenantId: "t", intentId: "i", audience, json, digest,
    source: "stored-evidence", issuerAuthenticated: false, providerContacted: false, executionAuthorized: false, settlementAuthorized: false } } };
}
