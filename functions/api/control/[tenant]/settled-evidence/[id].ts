import { jsonResponse } from "../../../../../lib/auth-request";
import { requestSettledEvidence, type SettledEvidenceEnv } from "../../../../../lib/settled-evidence-request";

export async function onRequestGet({ request, env, params }: {
  request: Request; env: SettledEvidenceEnv; params: { tenant: string; id: string };
}) {
  const { body, status } = await requestSettledEvidence(request, env, params.tenant, params.id);
  return jsonResponse(body, { status });
}
