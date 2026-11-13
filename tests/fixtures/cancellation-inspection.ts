import { syntheticCancellationEvidence } from "./cancellation-evidence";
import { canonicalControlJson, sha256Text } from "../../lib/control-objects";

export async function cancellationInspectionFixture() {
  const data = await syntheticCancellationEvidence(), json = canonicalControlJson(data), digest = await sha256Text(json);
  return { data, body: { ok: true, evidence: { tenantId: "t", intentId: "i", audience: data.audience, json, digest,
    scope: "recorded-request-only", source: "stored-evidence", issuerAuthenticated: false, cancellationConfirmed: false,
    providerContacted: false, cancellationAuthorized: false, executionAuthorized: false, settlementAuthorized: false } } };
}
