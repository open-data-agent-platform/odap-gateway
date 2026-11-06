import { jsonResponse } from "../../../../lib/auth-request";
import { commandError, readScopedContractCommand, type DelegationContext } from "../../../../lib/control-command-request";
import { issueDelegatedContract } from "../../../../lib/delegated-issuance";

export async function onRequestPost(context: DelegationContext) {
  try {
    const scoped = await readScopedContractCommand(context, "contract_issuance");
    if (scoped instanceof Response) return scoped;
    const result = await issueDelegatedContract(scoped.access, scoped.audience, scoped.id);
    if (!result) return commandError(409, "contract_issuance_unavailable");
    return jsonResponse({ ok: true, issuance: { delegationId: scoped.id, contractId: result.contractId } },
      { status: result.replay ? 200 : 201, headers: { Location: "/api/control/" + context.params.tenant + "/contract/" + result.contractId } });
  } catch { return commandError(503, "control_storage_unavailable"); }
}
