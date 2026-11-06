import { proveDelegation } from "../../../../lib/agent-delegations";
import { jsonResponse } from "../../../../lib/auth-request";
import { commandError, commandRequestError, exactFields, readCommandBody, routeId, type DelegationContext } from "../../../../lib/control-command-request";

export async function onRequestPost({ request, env, params }: DelegationContext) {
  try {
    const invalid = commandRequestError(request, params.tenant);
    if (invalid) return invalid;
    const audience = env.ODAP_DELEGATION_AUDIENCE, db = env.ODAP_GATEWAY_DB ?? env.DB;
    if (!audience || !routeId.test(audience) || !db) return commandError(503, "delegation_not_configured");
    const body = await readCommandBody(request, 2048, "delegation_proof");
    if (body instanceof Response) return body;
    const d = body.data;
    if (!exactFields(d, ["delegationId","signature"]) || typeof d.delegationId !== "string" ||
        !routeId.test(d.delegationId) || typeof d.signature !== "string") return commandError(400, "invalid_delegation_proof");
    const proof = await proveDelegation(db, audience, params.tenant, d.delegationId, d.signature);
    return proof ? jsonResponse({ ok: true, proof }, { status: 201 }) : commandError(403, "delegation_proof_denied");
  } catch { return commandError(503, "control_storage_unavailable"); }
}
