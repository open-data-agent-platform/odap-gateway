import { jsonResponse } from "../../../../lib/auth-request";
import { commandError, readScopedContractCommand, type DelegationContext } from "../../../../lib/control-command-request";
import { admitDelegatedContract } from "../../../../lib/delegated-admission";

export async function onRequestPost(context: DelegationContext) {
  try {
    const scoped = await readScopedContractCommand(context, "budget_admission");
    if (scoped instanceof Response) return scoped;
    const result = await admitDelegatedContract(scoped.access, scoped.audience, scoped.id);
    if (!result) return commandError(409, "budget_admission_unavailable");
    return jsonResponse({ ok: true, admission: { contractId: scoped.id, intentId: result.intentId } },
      { status: result.replay ? 200 : 201 });
  } catch { return commandError(503, "control_storage_unavailable"); }
}
