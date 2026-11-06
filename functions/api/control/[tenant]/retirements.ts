import { jsonResponse } from "../../../../lib/auth-request";
import { commandError, exactFields, readOwnerCommand, routeId, type TenantCommandContext } from "../../../../lib/control-command-request";
import { InvalidSemanticRetirement, retireSemanticRelease, SemanticRetirementUnavailable } from "../../../../lib/semantic-candidate-storage";

export async function onRequestPost(context: TenantCommandContext) {
  try {
    const command = await readOwnerCommand(context, "retirement");
    if (command instanceof Response) return command;
    const { access, data } = command;
    if (!exactFields(data, ["releaseId", "reason"]) || typeof data.releaseId !== "string" ||
        !routeId.test(data.releaseId) || typeof data.reason !== "string") {
      return commandError(400, "invalid_retirement");
    }
    const retirement = await retireSemanticRelease(access, data.releaseId, data.reason);
    return jsonResponse({ ok: true, retirement, effect: "future_dispatch_claims_only" },
      { status: retirement.status === "retired" ? 201 : 200,
        headers: { Location: "/api/control/" + access.tenantId + "/release/" + data.releaseId } });
  } catch (error) {
    if (error instanceof InvalidSemanticRetirement) return commandError(400, "invalid_retirement");
    if (error instanceof SemanticRetirementUnavailable) return commandError(404, "not_found");
    return commandError(503, "control_storage_unavailable");
  }
}
