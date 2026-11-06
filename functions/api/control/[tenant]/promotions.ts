import { jsonResponse } from "../../../../lib/auth-request";
import { commandError, exactFields, readOwnerCommand, routeId, type TenantCommandContext } from "../../../../lib/control-command-request";
import { promoteSemanticRevision } from "../../../../lib/semantic-candidate-storage";
import { readReviewDefinition, readSemanticReview } from "../../../../lib/semantic-review";

// Only the application-owned RAISE(ABORT) diagnostic is a business refusal.
// Missing migrations, audit failures and unrecognized driver errors remain 503.
function refused(error: unknown) {
  const guard = /^(?:D1_ERROR: )?semantic promotion unavailable(?:: SQLITE_CONSTRAINT(?:_TRIGGER)?)?$/;
  return error instanceof Error && (guard.test(error.message) ||
    (error.cause instanceof Error && guard.test(error.cause.message)));
}

export async function onRequestPost(context: TenantCommandContext) {
  try {
    const command = await readOwnerCommand(context, "promotion");
    if (command instanceof Response) return command;
    const { data, access } = command;
    if (!exactFields(data, ["revisionId", "approvalId", "releaseId"]) ||
        typeof data.revisionId !== "string" || !routeId.test(data.revisionId) ||
        typeof data.approvalId !== "string" || !routeId.test(data.approvalId) ||
        typeof data.releaseId !== "string" || !routeId.test(data.releaseId)) {
      return commandError(400, "invalid_promotion");
    }
    const { revisionId, approvalId, releaseId } = data;
    const review = await readSemanticReview(access, revisionId);
    if (review?.state !== "approved" || review.approvalId !== approvalId) return commandError(409, "promotion_not_recorded");
    const revision = await readReviewDefinition(access, revisionId);
    if (!revision || revision.definitionDigest !== review.definitionDigest) return commandError(409, "promotion_not_recorded");
    // The database rechecks owner, approval, withdrawal, catalog and uniqueness
    // at insertion; the review snapshot above is not permission to publish.
    const promotion = await promoteSemanticRevision(access, { revisionId, approvalId, releaseId });
    return jsonResponse({ ok: true, promotion }, { status: 201,
      headers: { Location: "/api/control/" + access.tenantId + "/release/" + promotion.releaseId } });
  } catch (error) {
    return refused(error) ? commandError(409, "promotion_not_recorded") : commandError(503, "control_storage_unavailable");
  }
}
