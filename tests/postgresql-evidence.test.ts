import { expect, it } from "vitest";
import { canonicalControlJson, sha256Text } from "../lib/control-objects";
import { postgresEvidenceMaxBytes, verifyPostgresEvidence } from "../lib/postgresql-evidence";
import { postgresEvidenceScope as scope, syntheticPostgresEvidence, syntheticPostgresEvidenceJson } from "./fixtures/postgresql-evidence";

it("verifies a bounded local claim without authenticating an issuer, provider or Agent", async () => {
  const json = await syntheticPostgresEvidenceJson();
  expect(await verifyPostgresEvidence(json, scope, await sha256Text(json))).toMatchObject({ consistent: true,
    state: "observation-required", monetaryCost: "unpriced", authorizationGranted: false,
    issuerAuthenticated: false, providerVerified: false, agentSignatureVerified: false, cancellationConfirmed: false });
});
const mutations: Record<string, (data: ReturnType<typeof JSON.parse>) => void> = {
  "profile": d => { d.profile = "other"; }, "money": d => { d.monetaryCost = 0; },
  "extra fields": d => { d.password = "synthetic-private"; }, "tenant": d => { d.release.tenantId = "peer"; },
  "release digest": d => { d.release.definitionDigest = "sha256:" + "b".repeat(64); },
  "source revision": d => { d.source.id = "other"; }, "source relation": d => { d.source.relation.table = "other"; },
  "source owner": d => { d.source.ownerId = "other"; }, "connection digest": d => { d.source.connectionDigest = "unknown"; },
  "contract release": d => { d.contract.semanticReleaseId = "other"; }, "contract action": d => { d.contract.actionDigest = "sha256:" + "b".repeat(64); },
  "contract source": d => { d.contract.sourceRevision = "other"; }, "contract policy": d => { d.contract.policyRevision = "other"; },
  "contract principal": d => { d.contract.principalId = "other"; }, "contract authority": d => { d.contract.authority.reference = "other"; },
  "target substitution": d => { d.source.target = d.contract.target = "other"; },
  "statement digest": d => { d.claim.statementDigest = "sha256:" + "b".repeat(64); },
  "claim after expiry": d => { d.claim.claimedAt = d.contract.expiresAt; },
  "receipt missing": d => { d.receipts = []; }, "duplicate receipt": d => { d.receipts.push(d.receipts[0]); },
  "receipt tenant": d => { d.receipts[0].tenantId = "peer"; }, "receipt intent": d => { d.receipts[0].intentId = "other"; },
  "receipt contract": d => { d.receipts[0].contractId = "other"; }, "receipt reason": d => { d.receipts[0].reason = "success"; },
  "receipt outcome": d => { d.receipts[0].outcome = "succeeded"; },
  "receipt time": d => { d.receipts[0].recordedAt = "2025-01-01T00:00:00.000Z"; },
  "unwitnessed success": d => { d.observation = { outcome: "succeeded", recordedAt: d.claim.claimedAt }; },
  "unsupported failure": d => { d.failure = { sqlState: "XX000", statementDigest: d.claim.statementDigest, recordedAt: d.claim.claimedAt }; },
  "caller cancellation": d => { d.cancellation = { requestedBy: "other", recordedAt: d.claim.claimedAt }; },
};
it.each(Object.entries(mutations))("rejects %s even with a matching outer checksum", async (_, mutate) => {
  const data = await syntheticPostgresEvidence(); mutate(data);
  const json = canonicalControlJson(data);
  await expect(verifyPostgresEvidence(json, scope, await sha256Text(json))).rejects.toThrow();
});
it.each(["tenantId", "requestId", "intentId"])("requires the externally selected %s", async key => {
  await expect(verifyPostgresEvidence(await syntheticPostgresEvidenceJson(), { ...scope, [key]: "other" })).rejects.toThrow("scope mismatch");
});
it("rejects coordinated record replacement against an independently retained checksum", async () => {
  const data = await syntheticPostgresEvidence(), original = await sha256Text(canonicalControlJson(data));
  data.source.connectionDigest = "sha256:" + "b".repeat(64);
  await expect(verifyPostgresEvidence(canonicalControlJson(data), scope, original)).rejects.toThrow("checksum mismatch");
});
it("rejects noncanonical, duplicate-key, malformed and oversized inputs", async () => {
  const json = await syntheticPostgresEvidenceJson();
  for (const bad of [json + "\n", '{"profile":"ignored",' + json.slice(1), "private-content", " ".repeat(postgresEvidenceMaxBytes + 1)]) {
    await expect(verifyPostgresEvidence(bad, scope)).rejects.toThrow();
  }
});
