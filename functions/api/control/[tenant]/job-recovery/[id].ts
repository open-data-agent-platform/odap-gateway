import { jsonResponse } from "../../../../../lib/auth-request";
import { requestDelegatedRecovery, type DelegatedRecoveryEnv } from "../../../../../lib/delegated-recovery-request";

export async function onRequestGet({ request, env, params }: {
  request: Request; env: DelegatedRecoveryEnv; params: { tenant: string; id: string };
}) {
  const { body, status } = await requestDelegatedRecovery(request,env,params.tenant,params.id);
  return jsonResponse(body,{ status });
}
