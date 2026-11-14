import { gatewayPath } from "./gateway-path";
import { isControlTimestamp } from "./control-objects";
import { withProviderDeadline } from "./provider-response";
import { readBoundedJsonBody } from "./request-json";
import type { requestDispatchStop } from "./dispatch-stop-request";

export type DispatchStopReport = Extract<Awaited<ReturnType<typeof requestDispatchStop>>["body"], { ok: true }>["dispatchStop"];
export type DispatchStopInspection = { state: "ready"; report: DispatchStopReport } |
  { state: "invalid" | "unauthenticated" | "denied" | "unavailable" };
export type DispatchStopAction = DispatchStopInspection | { state: "ineligible" | "unknown" };
const routeId = /^[A-Za-z0-9_-]{1,128}$/;
const keys = ["tenantId", "intentId", "state", "source", "scope", "providerContacted", "cancellationConfirmed", "executionAuthorized", "settlementAuthorized"];
function shape(value: unknown, fields: string[]): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key));
}
function validReport(value: unknown, tenant: string, intent: string): value is DispatchStopReport {
  const stopped = (value as { state?: unknown } | null)?.state === "stopped";
  if (!shape(value, stopped ? [...keys, "stoppedBy", "stoppedAt"] : keys) || value.tenantId !== tenant || value.intentId !== intent ||
      value.source !== "stored-evidence" || value.scope !== "local-dispatch-stop" || value.providerContacted !== false ||
      value.cancellationConfirmed !== false || value.executionAuthorized !== false || value.settlementAuthorized !== false) return false;
  return stopped ? typeof value.stoppedBy === "string" && value.stoppedBy.trim().length > 0 && value.stoppedBy.length <= 512 &&
    !/[\u0000-\u001f\u007f]/.test(value.stoppedBy) && isControlTimestamp(value.stoppedAt) :
    ["not-stopped", "legacy-stop", "already-claimed", "already-settled"].includes(value.state as string);
}
async function body(response: Response, signal: AbortSignal) {
  return readBoundedJsonBody({ body: response.body, bodyUsed: response.bodyUsed, headers: response.headers, signal }, 8192);
}
function refusal(status: number, value: unknown): "unauthenticated" | "denied" | undefined {
  if (!shape(value, ["ok", "code"]) || value.ok !== false) return;
  if (status === 401 && value.code === "unauthenticated") return "unauthenticated";
  if (status === 403 && ["tenant_access_denied", "same_origin_required"].includes(value.code as string)) return "denied";
}
async function read(tenant: string, intent: string, signal: AbortSignal, get: typeof fetch): Promise<DispatchStopInspection> {
  const response = await get(gatewayPath("/api/control/") + tenant + "/dispatch-stops/" + intent,
    { method: "GET", credentials: "same-origin", cache: "no-store", redirect: "error", signal });
  const parsed = await body(response, signal);
  if (!parsed.ok || signal.aborted) return { state: "unavailable" };
  const denied = refusal(response.status, parsed.value);
  if (denied) return { state: denied };
  if (response.status !== 200 || !shape(parsed.value, ["ok", "dispatchStop"]) || parsed.value.ok !== true ||
      !validReport(parsed.value.dispatchStop, tenant, intent)) return { state: "unavailable" };
  return { state: "ready", report: parsed.value.dispatchStop };
}
export async function inspectDispatchStop(tenant: string, intent: string, signal: AbortSignal,
  get: typeof fetch = fetch): Promise<DispatchStopInspection> {
  if (!routeId.test(tenant) || !routeId.test(intent)) return { state: "invalid" };
  if (signal.aborted) return { state: "unavailable" };
  try { return await withProviderDeadline(deadline => read(tenant, intent, AbortSignal.any([signal, deadline]), get), "Stop lookup timed out"); }
  catch { return { state: "unavailable" }; }
}
export async function recordReviewedDispatchStop(reviewed: DispatchStopReport, signal: AbortSignal,
  send: typeof fetch = fetch): Promise<DispatchStopAction> {
  if (!routeId.test(reviewed.tenantId) || !routeId.test(reviewed.intentId) ||
      !validReport(reviewed, reviewed.tenantId, reviewed.intentId) || reviewed.state !== "not-stopped") return { state: "ineligible" };
  if (signal.aborted) return { state: "unknown" };
  try {
    return await withProviderDeadline(async deadline => {
      const active = AbortSignal.any([signal, deadline]);
      const fresh = await read(reviewed.tenantId, reviewed.intentId, active, send);
      if (active.aborted) return { state: "unknown" };
      if (fresh.state !== "ready") return fresh.state === "unavailable" ? { state: "unknown" } : fresh;
      if (fresh.report.state !== "not-stopped") return { state: "ineligible" };
      const response = await send(gatewayPath("/api/control/") + reviewed.tenantId + "/dispatch-stops", {
        method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error", signal: active,
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ intentId: reviewed.intentId })
      });
      const parsed = await body(response, active);
      if (!parsed.ok || active.aborted) return { state: "unknown" };
      const denied = refusal(response.status, parsed.value);
      if (denied) return { state: denied };
      if (response.status === 409 && shape(parsed.value, ["ok", "code"]) && parsed.value.ok === false &&
          parsed.value.code === "dispatch_stop_unavailable") return { state: "ineligible" };
      if (response.status !== 200 || !shape(parsed.value, ["ok", "dispatchStop"]) || parsed.value.ok !== true ||
          !shape(parsed.value.dispatchStop, [...keys.filter(key => key !== "state" && key !== "source"), "stoppedBy", "stoppedAt"])) return { state: "unknown" };
      const ack = { ...parsed.value.dispatchStop, state: "stopped", source: "stored-evidence" };
      if (!validReport(ack, reviewed.tenantId, reviewed.intentId) || ack.state !== "stopped") return { state: "unknown" };
      // Acknowledgement alone is insufficient: reread the immutable owner-scoped marker.
      const saved = await read(reviewed.tenantId, reviewed.intentId, active, send);
      if (active.aborted) return { state: "unknown" };
      if (saved.state === "unauthenticated" || saved.state === "denied") return saved;
      return saved.state === "ready" && saved.report.state === "stopped" && saved.report.stoppedBy === ack.stoppedBy &&
        saved.report.stoppedAt === ack.stoppedAt ? saved : { state: "unknown" };
    }, "Stop recording timed out");
  } catch { return { state: "unknown" }; }
}
