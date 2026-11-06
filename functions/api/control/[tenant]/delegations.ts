import { createDelegation, revokeDelegation } from "../../../../lib/agent-delegations";
import { jsonResponse } from "../../../../lib/auth-request";
import { commandError, commandRequestError, exactFields, readCommandBody, routeId, type DelegationContext } from "../../../../lib/control-command-request";
import { authorizeControlRequest } from "../../../../lib/control-storage";

export async function onRequestPost({ request, env, params }: DelegationContext) {
  try {
    const invalid = commandRequestError(request, params.tenant);
    if (invalid) return invalid;
    const auth = await authorizeControlRequest(request, env, params.tenant);
    if (!auth.ok) return commandError(auth.status, auth.code);
    const audience = env.ODAP_DELEGATION_AUDIENCE;
    if (!audience || !routeId.test(audience)) return commandError(503, "delegation_not_configured");
    const body = await readCommandBody(request, 2048, "delegation");
    if (body instanceof Response) return body;
    const d = body.data;
    if (exactFields(d, ["operation","grantId","agentId","keyId"]) && d.operation === "create" &&
        typeof d.grantId === "string" && routeId.test(d.grantId) && typeof d.agentId === "string" && routeId.test(d.agentId) &&
        typeof d.keyId === "string" && routeId.test(d.keyId)) {
      const delegation = await createDelegation(auth.access, audience, d.grantId, d.agentId, d.keyId);
      return delegation ? jsonResponse({ ok: true, delegation }) : commandError(409, "delegation_unavailable");
    }
    if (exactFields(d, ["operation","delegationId"]) && d.operation === "revoke" &&
        typeof d.delegationId === "string" && routeId.test(d.delegationId)) {
      const revocation = await revokeDelegation(auth.access, audience, d.delegationId);
      return revocation ? jsonResponse({ ok: true, revocation }) : commandError(409, "delegation_unavailable");
    }
    return commandError(400, "invalid_delegation");
  } catch { return commandError(503, "control_storage_unavailable"); }
}
