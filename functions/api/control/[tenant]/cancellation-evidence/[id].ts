import { jsonResponse } from "../../../../../lib/auth-request";
import { requestCancellationEvidence, type CancellationEvidenceEnv } from "../../../../../lib/cancellation-evidence-request";

export async function onRequestGet({ request, env, params }: {
  request: Request; env: CancellationEvidenceEnv; params: { tenant: string; id: string };
}) {
  const { body, status } = await requestCancellationEvidence(request, env, params.tenant, params.id);
  return jsonResponse(body, { status });
}
