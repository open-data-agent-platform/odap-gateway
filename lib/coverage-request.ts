import { authorizeControlRequest } from "./control-storage";
import { readEvidenceCoverage } from "./evidence-coverage";

export type CoverageEnv = Parameters<typeof authorizeControlRequest>[1];
const failure = (status: number, code: string) => ({ status, body: { ok: false as const, code } });

export async function requestEvidenceCoverage(request: Request, env: CoverageEnv, tenant: unknown) {
  if (typeof tenant !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(tenant)) return failure(400, "invalid_control_path");
  try {
    const auth = await authorizeControlRequest(request, env, tenant);
    if (!auth.ok) return failure(auth.status, auth.code);
    if (auth.role !== "owner") return failure(403, "tenant_access_denied");
    // Recheck live ownership in the same SELECT that produces the counts.
    const coverage = await readEvidenceCoverage(auth.access);
    if (!coverage) return failure(403, "tenant_access_denied");
    return { status: 200, body: { ok: true as const, coverage } };
  } catch {
    return failure(503, "control_storage_unavailable");
  }
}
