import { gatewayPath } from "./gateway-path";
import { withProviderDeadline } from "./provider-response";
import { readBoundedJsonBody } from "./request-json";
import { inspectRecovery, type RecoveryReport } from "./recovery-inspection";
import { inspectCancellationEvidence, type CancellationEvidenceReport } from "./cancellation-evidence-inspection";

export type OwnerCancellationResult = { state: "recorded"; report: CancellationEvidenceReport } |
  { state: "ineligible" | "unauthenticated" | "denied" | "incompatible" | "unknown" };
const routeId = /^[A-Za-z0-9_-]{1,128}$/;
function shape(value: unknown, keys: string[]): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
const sameJob = (a: RecoveryReport["jobReference"], b: RecoveryReport["jobReference"]) =>
  a.projectId === b.projectId && a.location === b.location && a.jobId === b.jobId;
const validScope = (r: RecoveryReport) => routeId.test(r.tenantId) && routeId.test(r.intentId);

async function readRecorded(reviewed: RecoveryReport, signal: AbortSignal, get: typeof fetch): Promise<OwnerCancellationResult> {
  const read = await inspectCancellationEvidence(reviewed.tenantId, reviewed.intentId, signal, get);
  if (signal.aborted) return { state: "unknown" };
  if (read.state !== "ready") return { state: ["unauthenticated", "denied", "incompatible"].includes(read.state)
    ? read.state as "unauthenticated" | "denied" | "incompatible" : "unknown" };
  const job = JSON.parse(read.report.json).job;
  return sameJob(job, reviewed.jobReference) && read.report.pendingReceiptId === reviewed.receiptId
    ? { state: "recorded", report: read.report } : { state: "unknown" };
}

export async function recoverReviewedCancellation(reviewed: RecoveryReport, signal: AbortSignal,
  get: typeof fetch = fetch): Promise<OwnerCancellationResult> {
  if (!validScope(reviewed)) return { state: "ineligible" };
  if (signal.aborted) return { state: "unknown" };
  try { return await withProviderDeadline(deadline => readRecorded(reviewed, AbortSignal.any([signal, deadline]), get), "Request lookup timed out"); }
  catch { return { state: "unknown" }; }
}

export async function recordReviewedCancellation(reviewed: RecoveryReport, signal: AbortSignal,
  send: typeof fetch = fetch): Promise<OwnerCancellationResult> {
  if (!validScope(reviewed) || reviewed.observation !== null || reviewed.source !== "stored-evidence" ||
      reviewed.providerContacted !== false || reviewed.executionAuthorized !== false || reviewed.settlementAuthorized !== false) return { state: "ineligible" };
  if (signal.aborted) return { state: "unknown" };
  try {
    return await withProviderDeadline(async deadline => {
      const active = AbortSignal.any([signal, deadline]);
      const current = await inspectRecovery(reviewed.tenantId, reviewed.intentId, active, send);
      if (active.aborted) return { state: "unknown" };
      if (current.state !== "ready") return { state: ["unauthenticated", "denied", "incompatible"].includes(current.state)
        ? current.state as "unauthenticated" | "denied" | "incompatible" : "unknown" };
      if (current.report.observation !== null || current.report.receiptId !== reviewed.receiptId ||
          !sameJob(current.report.jobReference, reviewed.jobReference)) return { state: "ineligible" };
      const response = await send(gatewayPath("/api/control/") + reviewed.tenantId + "/cancellation-requests", {
        method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error", signal: active,
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ intentId: reviewed.intentId })
      });
      const parsed = await readBoundedJsonBody({ body: response.body, bodyUsed: response.bodyUsed, headers: response.headers, signal: active }, 8192);
      if (!parsed.ok || active.aborted) return { state: "unknown" };
      const body = parsed.value;
      if (shape(body, ["ok", "code"]) && body.ok === false) {
        if (response.status === 401 && body.code === "unauthenticated") return { state: "unauthenticated" };
        if (response.status === 403 && ["tenant_access_denied", "cancellation_request_denied", "same_origin_required"].includes(body.code as string)) return { state: "denied" };
        if (response.status === 409 && body.code === "cancellation_request_unavailable") return { state: "ineligible" };
        if (response.status === 503 && body.code === "delegation_not_configured") return { state: "incompatible" };
      }
      if (response.status !== 200 || !shape(body, ["ok", "cancellationRequest"]) || body.ok !== true ||
          !shape(body.cancellationRequest, ["tenantId", "intentId", "requestedBy", "requestedAt", "scope", "providerContacted",
            "cancellationConfirmed", "cancellationAuthorized", "executionAuthorized", "settlementAuthorized"])) return { state: "unknown" };
      const ack = body.cancellationRequest;
      if (ack.tenantId !== reviewed.tenantId || ack.intentId !== reviewed.intentId || ack.scope !== "recorded-request-only" ||
          typeof ack.requestedBy !== "string" || !ack.requestedBy || typeof ack.requestedAt !== "string" ||
          !Number.isFinite(Date.parse(ack.requestedAt)) || ack.providerContacted !== false || ack.cancellationConfirmed !== false ||
          ack.cancellationAuthorized !== false || ack.executionAuthorized !== false || ack.settlementAuthorized !== false) return { state: "unknown" };
      // A command acknowledgement is not proof: reread the separately verified request profile.
      const saved = await readRecorded(reviewed, active, send);
      if (saved.state !== "recorded") return saved;
      return saved.report.requestedBy === ack.requestedBy && saved.report.requestedAt === ack.requestedAt ? saved : { state: "unknown" };
    }, "Request recording timed out");
  } catch { return { state: "unknown" }; }
}
