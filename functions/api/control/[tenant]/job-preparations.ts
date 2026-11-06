import { jsonResponse } from "../../../../lib/auth-request";
import { commandError, readScopedContractCommand, type DelegationContext } from "../../../../lib/control-command-request";
import { prepareDelegatedJob } from "../../../../lib/delegated-job-preparation";

export async function onRequestPost(context: DelegationContext) {
  try {
    const scoped = await readScopedContractCommand(context, "job_preparation");
    if (scoped instanceof Response) return scoped;
    const result = await prepareDelegatedJob(scoped.access, scoped.audience, scoped.id);
    if (!result) return commandError(409, "job_preparation_unavailable");
    return jsonResponse({ ok: true, preparation: result.preparation }, { status: result.replay ? 200 : 201,
      headers: { Location: "/api/control/" + context.params.tenant + "/receipt/" + result.preparation.receiptId } });
  } catch { return commandError(503, "control_storage_unavailable"); }
}
