import { jsonResponse } from "../../../../lib/auth-request";
import { requestEvidenceCoverage, type CoverageEnv } from "../../../../lib/coverage-request";

export async function onRequestGet({ request, env, params }: {
  request: Request; env: CoverageEnv; params: { tenant: string };
}) {
  const { body, status } = await requestEvidenceCoverage(request, env, params.tenant);
  return jsonResponse(body, { status });
}
