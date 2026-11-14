import { jsonResponse } from "../../../../../lib/auth-request";
import { requestDispatchStop, type DispatchStopEnv } from "../../../../../lib/dispatch-stop-request";

export async function onRequestGet({ request, env, params }: {
  request: Request; env: DispatchStopEnv; params: { tenant: string; id: string };
}) {
  const { body, status } = await requestDispatchStop(request, env, params.tenant, params.id);
  return jsonResponse(body, { status });
}
