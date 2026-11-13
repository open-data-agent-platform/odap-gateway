import { gatewayPath } from "./gateway-path";
import { intentJobId } from "./bigquery-job-identity";
import type { requestDelegatedRecovery } from "./delegated-recovery-request";

export type RecoveryReport = Extract<Awaited<ReturnType<typeof requestDelegatedRecovery>>["body"], { ok: true }>["recovery"];
export type RecoveryInspection = { state: "ready"; report: RecoveryReport } |
  { state: "invalid" | "unauthenticated" | "denied" | "incompatible" | "unavailable" };
const routeId = /^[A-Za-z0-9_-]{1,128}$/;
function shape(value: unknown, keys: string[]): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
const text = (value: unknown): value is string => typeof value === "string" &&
  value.trim().length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);

function validReport(value: unknown, tenant: string, intent: string, jobId: string): value is RecoveryReport {
  if (!shape(value, ["tenantId", "intentId", "jobReference", "receiptId", "observation", "source",
    "providerContacted", "executionAuthorized", "settlementAuthorized"]) ||
    value.tenantId !== tenant || value.intentId !== intent || value.source !== "stored-evidence" ||
    value.providerContacted !== false || value.executionAuthorized !== false || value.settlementAuthorized !== false ||
    !shape(value.jobReference, ["projectId", "location", "jobId"]) ||
    !text(value.jobReference.projectId) || !text(value.jobReference.location) || value.jobReference.jobId !== jobId ||
    value.receiptId !== "pending_" + jobId) return false;
  const observation = value.observation;
  return observation === null || (shape(observation, ["state", "billedBytes", "observedAt", "observedBy"]) &&
    ["succeeded", "failed", "cancelled"].includes(observation.state as string) &&
    (observation.billedBytes === null || (typeof observation.billedBytes === "number" &&
      Number.isSafeInteger(observation.billedBytes) && observation.billedBytes >= 0 && !Object.is(observation.billedBytes, -0))) &&
    text(observation.observedAt) && Number.isFinite(Date.parse(observation.observedAt)) && text(observation.observedBy));
}

export async function inspectRecovery(tenant: string, intent: string, signal: AbortSignal,
  get: typeof fetch = fetch): Promise<RecoveryInspection> {
  if (!routeId.test(tenant) || !routeId.test(intent)) return { state: "invalid" };
  try {
    const response = await get(gatewayPath("/api/control/") + tenant + "/job-recovery/" + intent, {
      method: "GET", credentials: "same-origin", cache: "no-store", redirect: "error", signal
    });
    if (response.status === 401) return { state: "unauthenticated" };
    if (response.status === 403) return { state: "denied" };
    if (response.status === 503) {
      const body = await response.json();
      return { state: body?.ok === false && ["job_recovery_unavailable", "delegation_not_configured"].includes(body.code)
        ? "incompatible" : "unavailable" };
    }
    if (response.status !== 200) return { state: "unavailable" };
    const body = await response.json();
    if (!shape(body, ["ok", "recovery"]) || body.ok !== true ||
        !validReport(body.recovery, tenant, intent, await intentJobId(tenant, intent))) return { state: "unavailable" };
    return { state: "ready", report: body.recovery };
  } catch { return { state: "unavailable" }; }
}
