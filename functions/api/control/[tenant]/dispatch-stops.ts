import { jsonResponse } from "../../../../lib/auth-request";
import { commandError, exactFields, readOwnerCommand, routeId, type TenantCommandContext } from "../../../../lib/control-command-request";
import { stopBeforeDispatch } from "../../../../lib/pre-dispatch-stop";

export async function onRequestPost(context: TenantCommandContext) {
  try {
    if (new URL(context.request.url).search) return commandError(400, "invalid_dispatch_stop");
    const command = await readOwnerCommand(context, "dispatch_stop");
    if (command instanceof Response) return command;
    const { data, access } = command;
    if (!exactFields(data, ["intentId"]) || typeof data.intentId !== "string" || !routeId.test(data.intentId))
      return commandError(400, "invalid_dispatch_stop");
    const saved = await stopBeforeDispatch(access, data.intentId);
    if (saved.state !== "stopped") return commandError(409, "dispatch_stop_unavailable");
    // Only an attributed local stop is acknowledged, never a remote job outcome.
    return jsonResponse({ ok: true, dispatchStop: { tenantId: access.tenantId, intentId: data.intentId,
      stoppedBy: saved.stoppedBy, stoppedAt: saved.stoppedAt, scope: "local-dispatch-stop",
      providerContacted: false, cancellationConfirmed: false, executionAuthorized: false, settlementAuthorized: false } });
  } catch {
    return commandError(503, "control_storage_unavailable");
  }
}
