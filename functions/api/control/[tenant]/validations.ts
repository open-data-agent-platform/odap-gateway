import { jsonResponse } from "../../../../lib/auth-request";
import { commandError, exactFields, readOwnerCommand, routeId, type TenantCommandContext } from "../../../../lib/control-command-request";
import { InvalidSemanticValidation, recordSemanticValidation, SemanticValidationNotRecorded } from "../../../../lib/semantic-candidate-storage";

export async function onRequestPost(context: TenantCommandContext) {
  try {
    const body = await readOwnerCommand(context, "validation");
    if (body instanceof Response) return body;
    const { data } = body;
    if (!exactFields(data, ["revisionId", "reviewedDigest", "evidenceRef"]) ||
        typeof data.revisionId !== "string" || !routeId.test(data.revisionId) ||
        typeof data.reviewedDigest !== "string" || typeof data.evidenceRef !== "string") {
      return commandError(400, "invalid_validation");
    }
    await recordSemanticValidation(body.access, data.revisionId, data.reviewedDigest, data.evidenceRef);
    return jsonResponse({ ok: true, validation: { revisionId: data.revisionId, definitionDigest: data.reviewedDigest } },
      { status: 201, headers: { Location: "/api/control/" + body.access.tenantId + "/review/" + data.revisionId } });
  } catch (error) {
    if (error instanceof InvalidSemanticValidation) return commandError(400, "invalid_validation");
    if (error instanceof SemanticValidationNotRecorded) return commandError(409, "validation_not_recorded");
    return commandError(503, "control_storage_unavailable");
  }
}
