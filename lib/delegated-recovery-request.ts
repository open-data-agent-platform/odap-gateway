import { authorizeControlRequest } from "./control-storage";
import { routeId } from "./control-command-request";
import { DelegatedClaimUnavailableError, readDelegatedRecovery } from "./delegated-job-recovery";

export type DelegatedRecoveryEnv = Parameters<typeof authorizeControlRequest>[1] & { ODAP_DELEGATION_AUDIENCE?: string };
const failure = (status: number, code: string) => ({ status, body: { ok: false as const, code } });

export async function requestDelegatedRecovery(request: Request, env: DelegatedRecoveryEnv,
  tenant: unknown, intentId: unknown) {
  if (new URL(request.url).search) return failure(400, "invalid_recovery_view");
  if (typeof tenant !== "string" || !routeId.test(tenant) || typeof intentId !== "string" || !routeId.test(intentId))
    return failure(400, "invalid_control_path");
  try {
    const auth = await authorizeControlRequest(request, env, tenant);
    if (!auth.ok) return failure(auth.status, auth.code);
    if (auth.role !== "owner") return failure(403, "tenant_access_denied");
    const audience = env.ODAP_DELEGATION_AUDIENCE;
    if (!audience || !routeId.test(audience)) return failure(503, "delegation_not_configured");
    // Compatibility inspection is authenticated, uncached and never initializes storage.
    const capability = await auth.access.db.prepare(`SELECT (SELECT count(*) FROM sqlite_master
      WHERE (type='view' AND name='recoverable_delegated_jobs') OR
        (type='table' AND name='bigquery_terminal_observations')) AS objects
      FROM control_memberships WHERE tenant_id=? AND principal_id=? AND active=1 AND role='owner'`)
      .bind(tenant,auth.access.principalId).first<{ objects: number }>();
    if (!capability) return failure(403, "tenant_access_denied");
    if (capability.objects === 0 || capability.objects === 1) return failure(503, "job_recovery_unavailable");
    if (capability.objects !== 2) throw new Error("Invalid recovery capability");
    // This reader rechecks tenant ownership in the evidence statement. It has no default observer.
    const stored = await readDelegatedRecovery(auth.access,audience,intentId);
    const o = stored.observation;
    if (o && (!["succeeded","failed","cancelled"].includes(o.state) ||
        (o.billedBytes !== null && (!Number.isSafeInteger(o.billedBytes) || o.billedBytes < 0)) ||
        typeof o.observedAt !== "string" || !Number.isFinite(Date.parse(o.observedAt)) ||
        typeof o.observedBy !== "string" || !o.observedBy.trim())) throw new Error("Invalid stored observation");
    return { status: 200, body: { ok: true as const, recovery: { tenantId: tenant, intentId, ...stored,
      source: "stored-evidence" as const, providerContacted: false, executionAuthorized: false, settlementAuthorized: false } } };
  } catch (error) {
    return error instanceof DelegatedClaimUnavailableError
      ? failure(403, "tenant_access_denied") : failure(503, "control_storage_unavailable");
  }
}
