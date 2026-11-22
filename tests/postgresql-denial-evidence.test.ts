import { expect, it } from "vitest";
import { canonicalControlJson, sha256Text } from "../lib/control-objects";
import { postgresDenialEvidenceMaxBytes, verifyPostgresDenialEvidence } from "../lib/postgresql-denial-evidence";
import { postgresDenialScope as scope, syntheticPostgresDenial, syntheticPostgresDenialJson } from "./fixtures/postgresql-denial-evidence";

it("verifies a historical denial without claiming non-execution, action values or issuer authenticity", async () => {
  const json = syntheticPostgresDenialJson();
  expect(await verifyPostgresDenialEvidence(json, scope, await sha256Text(json))).toEqual({ consistent: true,
    recordedDecision: "denied", digest: await sha256Text(json), issuerAuthenticated: false, executionVerified: false,
    actionValuesVerified: false, authorizationGranted: false });
});
const mutations: Record<string, (data: ReturnType<typeof JSON.parse>) => void> = {
  profile: d => { d.profile = "other"; }, extra: d => { d.parameters = { secret: "private" }; },
  "extra denial": d => { d.denial.sql = "private"; }, "missing denial": d => { delete d.denial; },
  "principal": d => { d.denial.principalId = ""; }, "agent": d => { d.denial.agentId = "signed-agent"; },
  "release": d => { d.denial.requestedRelease = "bad release"; }, "digest": d => { d.denial.actionDigest = "sha256:bad"; },
  "denial time": d => { d.denial.recordedAt = "2026-02-30T00:00:00.000Z"; },
  "receipt id": d => { d.receipt.id = "other"; }, "receipt tenant": d => { d.receipt.tenantId = "peer"; },
  "receipt attempt": d => { d.receipt.intentId = "other"; }, "receipt contract": d => { d.receipt.contractId = "contract"; },
  "receipt release": d => { d.receipt.semanticReleaseId = "release"; }, "receipt outcome": d => { d.receipt.outcome = "succeeded"; },
  "receipt reason": d => { d.receipt.reason = "permission granted"; }, "receipt time": d => { d.receipt.recordedAt = "2026-01-01T00:00:00.001Z"; },
  "event actor": d => { d.creationEvent.actor = "google:other"; }, "event time": d => { d.creationEvent.recordedAt = "2026-01-01T00:00:00.001Z"; },
  "creation before denial": d => { d.receiptCreatedAt = d.creationEvent.recordedAt = "2025-01-01T00:00:00.000Z"; },
  "missing event": d => { d.creationEvent = null; }, "extra event": d => { d.creationEvent.authorized = true; },
};
it.each(Object.entries(mutations))("rejects %s with even a matching outer checksum", async (_, mutate) => {
  const data = syntheticPostgresDenial(); mutate(data); const json = canonicalControlJson(data);
  await expect(verifyPostgresDenialEvidence(json, scope, await sha256Text(json))).rejects.toThrow();
});
it.each(["tenantId", "attemptId"])("requires externally selected %s", async key => {
  await expect(verifyPostgresDenialEvidence(syntheticPostgresDenialJson(), { ...scope, [key]: "other" })).rejects.toThrow("scope mismatch");
});
it("detects internally consistent replacement against the independently retained checksum", async () => {
  const data = syntheticPostgresDenial(), pin = await sha256Text(canonicalControlJson(data));
  data.denial.requestedRelease = "different";
  await expect(verifyPostgresDenialEvidence(canonicalControlJson(data), scope, pin)).rejects.toThrow("checksum mismatch");
});
it("rejects duplicate keys, trailing bytes, noncanonical, malformed and oversized evidence", async () => {
  const json = syntheticPostgresDenialJson();
  for (const bad of [json + "\n", '{"profile":"ignored",' + json.slice(1), JSON.stringify(JSON.parse(json), null, 2),
    "private-value", " ".repeat(postgresDenialEvidenceMaxBytes + 1)]) await expect(verifyPostgresDenialEvidence(bad, scope)).rejects.toThrow();
});
it("bounds UTF-8 bytes as well as JavaScript characters", async () => {
  const json = '"' + "\u4e2d".repeat(6000) + '"'; expect(json.length).toBeLessThan(postgresDenialEvidenceMaxBytes);
  await expect(verifyPostgresDenialEvidence(json, scope)).rejects.toThrow();
});
