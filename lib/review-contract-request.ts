import { gatewayPath } from "./gateway-path";
import { canonicalControlJson, isControlTimestamp, sha256Text } from "./control-objects";
import type { previewAction } from "./review-metric-preview";

export type MetricAction = NonNullable<ReturnType<typeof previewAction>>;
export type RequestDraft = { requestId: string; releaseId: string; requestedAgentId: string; action: MetricAction };
export const validRequestId = (id: string) => /^[A-Za-z0-9_-]{1,128}$/.test(id);
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const refusalCodes: Record<number, string[]> = {
  400: ["invalid_requested_action", "invalid_contract_request", "invalid_control_path"],
  401: ["unauthenticated"], 403: ["same_origin_required", "tenant_access_denied"],
  409: ["contract_request_not_recorded"], 413: ["contract_request_too_large"], 415: ["json_required"]
};

export async function proposeMetricRequest(tenantId: string, draft: RequestDraft, signal: AbortSignal, post: typeof fetch = fetch) {
  if (![tenantId, draft.requestId, draft.releaseId, draft.requestedAgentId].every(validRequestId)) return "refused";
  try {
    const body = JSON.stringify(draft);
    const digest = await sha256Text(canonicalControlJson(JSON.parse(body).action));
    const res = await post(gatewayPath("/api/control/") + tenantId + "/contract-requests", { method: "POST", body,
      credentials: "same-origin", cache: "no-store", redirect: "error", headers: { "Content-Type": "application/json" },
      signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) });
    const b: unknown = await res.json();
    if (record(b) && b.ok === false && typeof b.code === "string" && refusalCodes[res.status]?.includes(b.code)) return "refused";
    const r = record(b) && b.ok === true ? b.request : null;
    if ((res.status === 201 || res.status === 200) && record(r) && r.state === "proposed" &&
        r.requestId === draft.requestId && r.releaseId === draft.releaseId && r.requestedAgentId === draft.requestedAgentId &&
        r.actionDigest === digest && isControlTimestamp(r.requestedAt)) return "proposed";
  } catch { /* Loss of an acknowledgement does not prove the request was refused. */ }
  return "unknown";
}
