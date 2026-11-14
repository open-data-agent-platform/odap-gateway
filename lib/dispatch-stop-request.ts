import { authorizeControlRequest } from "./control-storage";
import { routeId } from "./control-command-request";
import { PreDispatchStopUnavailableError, readPreDispatchStop } from "./pre-dispatch-stop";

export type DispatchStopEnv = Parameters<typeof authorizeControlRequest>[1];
const failure = (status: number, code: string) => ({ status, body: { ok: false as const, code } });

export async function requestDispatchStop(request: Request, env: DispatchStopEnv, tenant: unknown, intentId: unknown) {
  if (new URL(request.url).search) return failure(400, "invalid_dispatch_stop_view");
  if (typeof tenant !== "string" || !routeId.test(tenant) || typeof intentId !== "string" || !routeId.test(intentId))
    return failure(400, "invalid_control_path");
  try {
    const auth = await authorizeControlRequest(request, env, tenant);
    if (!auth.ok) return failure(auth.status, auth.code);
    if (auth.role !== "owner") return failure(403, "tenant_access_denied");
    // The SELECT rechecks current ownership with the stored facts; it never creates a stop.
    const stored = await readPreDispatchStop(auth.access, intentId);
    return { status: 200, body: { ok: true as const, dispatchStop: { tenantId: tenant, intentId, ...stored,
      source: "stored-evidence" as const, scope: "local-dispatch-stop" as const,
      providerContacted: false, cancellationConfirmed: false, executionAuthorized: false, settlementAuthorized: false } } };
  } catch (error) {
    return error instanceof PreDispatchStopUnavailableError
      ? failure(403, "tenant_access_denied") : failure(503, "control_storage_unavailable");
  }
}
