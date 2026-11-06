import { jsonResponse } from "../../../../lib/auth-request";
import { commandError, exactFields, readOwnerCommand, routeId, type TenantCommandContext } from "../../../../lib/control-command-request";
import { approveSemanticRevision, InvalidSemanticApproval, SemanticApprovalNotRecorded } from "../../../../lib/semantic-candidate-storage";

export async function onRequestPost(context: TenantCommandContext) {
  try {
    const command = await readOwnerCommand(context, "approval");
    if (command instanceof Response) return command;
    const { data, access } = command;
    if (!exactFields(data, ["approvalId", "revisionId", "reviewedDigest", "evidenceRef"]) ||
        typeof data.approvalId !== "string" || !routeId.test(data.approvalId) ||
        typeof data.revisionId !== "string" || !routeId.test(data.revisionId) ||
        typeof data.reviewedDigest !== "string" || typeof data.evidenceRef !== "string") {
      return commandError(400, "invalid_approval");
    }
    const { approvalId, revisionId, reviewedDigest, evidenceRef } = data;
    const approval = await approveSemanticRevision(access, { approvalId, revisionId, reviewedDigest, evidenceRef });
    return jsonResponse({ ok: true, approval }, { status: 201,
      headers: { Location: "/api/control/" + access.tenantId + "/review/" + revisionId } });
  } catch (error) {
    if (error instanceof InvalidSemanticApproval) return commandError(400, "invalid_approval");
    if (error instanceof SemanticApprovalNotRecorded) return commandError(409, "approval_not_recorded");
    return commandError(503, "control_storage_unavailable");
  }
}
