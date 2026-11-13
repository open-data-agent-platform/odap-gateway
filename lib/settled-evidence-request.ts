import { authorizeControlRequest } from "./control-storage";
import { routeId } from "./control-command-request";
import { exportSettledEvidence } from "./settled-evidence-export";

export type SettledEvidenceEnv = Parameters<typeof authorizeControlRequest>[1] & { ODAP_DELEGATION_AUDIENCE?: string };
const failure = (status: number, code: string) => ({ status, body: { ok: false as const, code } });

export async function requestSettledEvidence(request: Request, env: SettledEvidenceEnv, tenant: unknown, intentId: unknown) {
  if (new URL(request.url).search) return failure(400, "invalid_evidence_export");
  if (typeof tenant !== "string" || !routeId.test(tenant) || typeof intentId !== "string" || !routeId.test(intentId))
    return failure(400, "invalid_control_path");
  try {
    const auth = await authorizeControlRequest(request, env, tenant);
    if (!auth.ok) return failure(auth.status, auth.code);
    if (auth.role !== "owner") return failure(403, "tenant_access_denied");
    const audience = env.ODAP_DELEGATION_AUDIENCE;
    if (!audience || !routeId.test(audience)) return failure(503, "delegation_not_configured");
    // The export statement rechecks current ownership and the complete attributed chain.
    // A missing chain is not evidence that no job ran or that no charge remains.
    const exported = await exportSettledEvidence(auth.access, intentId, audience);
    if (!exported) return failure(403, "tenant_access_denied");
    return { status: 200, body: { ok: true as const, evidence: { tenantId: tenant, intentId, audience, ...exported,
      source: "stored-evidence" as const, issuerAuthenticated: false, providerContacted: false,
      executionAuthorized: false, settlementAuthorized: false } } };
  } catch {
    return failure(503, "control_storage_unavailable");
  }
}
