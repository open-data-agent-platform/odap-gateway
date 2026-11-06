import { jsonResponse } from "../../../../lib/auth-request";
import { commandError, exactFields, readOwnerCommand, routeId, type TenantCommandContext } from "../../../../lib/control-command-request";
import { InvalidSemanticWithdrawal, SemanticWithdrawalUnavailable, withdrawSemanticApproval } from "../../../../lib/semantic-candidate-storage";

export async function onRequestPost(context: TenantCommandContext) {
  try {
    const command = await readOwnerCommand(context, "withdrawal");
    if (command instanceof Response) return command;
    const { access, data } = command;
    if (!exactFields(data, ["approvalId", "revisionId", "reason"]) ||
        typeof data.approvalId !== "string" || !routeId.test(data.approvalId) ||
        typeof data.revisionId !== "string" || !routeId.test(data.revisionId) || typeof data.reason !== "string") {
      return commandError(400, "invalid_withdrawal");
    }
    const { approvalId, revisionId, reason } = data;
    const withdrawal = await withdrawSemanticApproval(access, { approvalId, revisionId, reason });
    if (withdrawal.status === "already_promoted") {
      return jsonResponse({ ok: false, code: "already_promoted", releaseId: withdrawal.releaseId }, { status: 409 });
    }
    return jsonResponse({ ok: true, withdrawal }, { status: withdrawal.status === "withdrawn" ? 201 : 200,
      headers: { Location: "/api/control/" + access.tenantId + "/review/" + revisionId } });
  } catch (error) {
    if (error instanceof InvalidSemanticWithdrawal) return commandError(400, "invalid_withdrawal");
    if (error instanceof SemanticWithdrawalUnavailable) return commandError(404, "not_found");
    return commandError(503, "control_storage_unavailable");
  }
}
