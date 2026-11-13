import { gatewayPath } from "./gateway-path";
import { readBoundedJsonBody } from "./request-json";
import { cancellationEvidenceMaxBytes, cancellationEvidenceScope, verifyCancellationEvidence } from "./cancellation-evidence";

export type CancellationEvidenceReport = { tenantId: string; intentId: string; audience: string; json: string; digest: string;
  jobId: string; pendingReceiptId: string; requestedBy: string; requestedAt: string };
export type CancellationEvidenceInspection = { state: "ready"; report: CancellationEvidenceReport } |
  { state: "invalid" | "unauthenticated" | "denied" | "incompatible" | "unavailable" };
const routeId = /^[A-Za-z0-9_-]{1,128}$/;
export const cancellationEnvelopeMaxBytes = 2 * cancellationEvidenceMaxBytes + 4096;
function shape(value: unknown, keys: string[]): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

export async function inspectCancellationEvidence(tenant: string, intent: string, signal: AbortSignal,
  get: typeof fetch = fetch): Promise<CancellationEvidenceInspection> {
  if (!routeId.test(tenant) || !routeId.test(intent)) return { state: "invalid" };
  try {
    const response = await get(gatewayPath("/api/control/") + tenant + "/cancellation-evidence/" + intent, {
      method: "GET", credentials: "same-origin", cache: "no-store", redirect: "error", signal
    });
    if (response.status === 401) return { state: "unauthenticated" };
    if (response.status === 403) return { state: "denied" };
    if (response.status !== 200 && response.status !== 503) return { state: "unavailable" };
    // Canonical JSON is escaped again inside the HTTP envelope.
    const parsed = await readBoundedJsonBody({ body: response.body, bodyUsed: response.bodyUsed, headers: response.headers, signal },
      response.status === 200 ? cancellationEnvelopeMaxBytes : 4096);
    if (!parsed.ok || signal.aborted) return { state: "unavailable" };
    const body = parsed.value;
    if (response.status === 503) return { state: shape(body, ["ok", "code"]) && body.ok === false &&
      body.code === "delegation_not_configured" ? "incompatible" : "unavailable" };
    if (!shape(body, ["ok", "evidence"]) || body.ok !== true ||
        !shape(body.evidence, ["tenantId", "intentId", "audience", "json", "digest", "scope", "source", "issuerAuthenticated",
          "cancellationConfirmed", "providerContacted", "cancellationAuthorized", "executionAuthorized", "settlementAuthorized"]))
      return { state: "unavailable" };
    const value = body.evidence;
    if (value.tenantId !== tenant || value.intentId !== intent || typeof value.audience !== "string" || !routeId.test(value.audience) ||
        typeof value.json !== "string" || typeof value.digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value.digest) ||
        value.scope !== cancellationEvidenceScope || value.source !== "stored-evidence" || value.issuerAuthenticated !== false ||
        value.cancellationConfirmed !== false || value.providerContacted !== false || value.cancellationAuthorized !== false ||
        value.executionAuthorized !== false || value.settlementAuthorized !== false) return { state: "unavailable" };
    const verified = await verifyCancellationEvidence(value.json, { tenantId: tenant, intentId: intent, audience: value.audience }, value.digest);
    if (signal.aborted) return { state: "unavailable" };
    // Only project fields after the exact stored profile and checksum have been checked.
    const data: { job: { jobId: string; pendingReceiptId: string }; request: { requestedBy: string; requestedAt: string } } = JSON.parse(value.json);
    return { state: "ready", report: { tenantId: tenant, intentId: intent, audience: value.audience, json: value.json,
      digest: verified.digest, jobId: data.job.jobId, pendingReceiptId: data.job.pendingReceiptId,
      requestedBy: data.request.requestedBy, requestedAt: data.request.requestedAt } };
  } catch { return { state: "unavailable" }; }
}

export function cancellationEvidenceFile(report: CancellationEvidenceReport, kind: "json" | "digest") {
  if (!/^sha256:[0-9a-f]{64}$/.test(report.digest)) throw new Error("Invalid evidence checksum");
  return { name: "cancellation-request-" + report.digest.slice(7) + (kind === "json" ? ".json" : ".sha256"),
    type: kind === "json" ? "application/json;charset=utf-8" : "text/plain;charset=utf-8",
    content: kind === "json" ? report.json : report.digest + "\n" };
}
