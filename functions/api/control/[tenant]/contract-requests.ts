import { jsonResponse } from "../../../../lib/auth-request";
import { commandError, commandRequestError, exactFields, readCommandBody, routeId, type TenantCommandContext } from "../../../../lib/control-command-request";
import { authorizeControlRequest } from "../../../../lib/control-storage";
import { InvalidRequestedAction, requestMetricContract } from "../../../../lib/contract-requests";

export async function onRequestPost({ request, env, params }: TenantCommandContext) {
  try {
    const invalid = commandRequestError(request, params.tenant);
    if (invalid) return invalid;
    const auth = await authorizeControlRequest(request, env, params.tenant);
    if (!auth.ok) return commandError(auth.status, auth.code);
    const body = await readCommandBody(request, 8 * 1024, "contract_request");
    if (body instanceof Response) return body;
    const d = body.data;
    if (!exactFields(d, ["requestId", "releaseId", "requestedAgentId", "action"]) ||
        typeof d.requestId !== "string" || !routeId.test(d.requestId) || typeof d.releaseId !== "string" ||
        !routeId.test(d.releaseId) || typeof d.requestedAgentId !== "string" || !routeId.test(d.requestedAgentId)) {
      return commandError(400, "invalid_contract_request");
    }
    const result = await requestMetricContract(auth.access, { requestId: d.requestId, releaseId: d.releaseId,
      requestedAgentId: d.requestedAgentId, action: d.action });
    if (!result) return commandError(409, "contract_request_not_recorded");
    return jsonResponse({ ok: true, request: result.request }, { status: result.replay ? 200 : 201 });
  } catch (error) {
    if (error instanceof InvalidRequestedAction) return commandError(400, "invalid_requested_action");
    return commandError(503, "control_storage_unavailable");
  }
}
