import { jsonResponse } from "../../../../lib/auth-request";
import { commandError, commandRequestError, exactFields, readCommandBody, routeId, type TenantCommandContext } from "../../../../lib/control-command-request";
import { authorizeControlRequest } from "../../../../lib/control-storage";
import { InvalidRequestedAction, prepareMetricPreview } from "../../../../lib/metric-preview";

export async function onRequestPost({ request, env, params }: TenantCommandContext) {
  try {
    const invalid = commandRequestError(request, params.tenant);
    if (invalid) return invalid;
    const auth = await authorizeControlRequest(request, env, params.tenant);
    if (!auth.ok) return commandError(auth.status, auth.code);
    const body = await readCommandBody(request, 8 * 1024, "metric_preview");
    if (body instanceof Response) return body;
    const d = body.data;
    if (!exactFields(d, ["releaseId", "action"]) || typeof d.releaseId !== "string" || !routeId.test(d.releaseId)) {
      return commandError(400, "invalid_metric_preview");
    }
    const prepared = await prepareMetricPreview(auth.access, d.releaseId, d.action);
    if (!prepared) return commandError(404, "metric_preview_unavailable");
    return jsonResponse({ ok: true, preview: { state: "compiled", releaseId: prepared.releaseId,
      parameterCount: prepared.compiled.queryParameters.length } });
  } catch (error) {
    if (error instanceof InvalidRequestedAction) return commandError(400, "invalid_requested_action");
    return commandError(503, "control_storage_unavailable");
  }
}
