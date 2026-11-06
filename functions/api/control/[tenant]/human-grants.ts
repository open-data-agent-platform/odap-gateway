import { jsonResponse } from "../../../../lib/auth-request";
import { commandError, parseGrantReview, readOwnerCommand, routeId, type TenantCommandContext } from "../../../../lib/control-command-request";
import { InvalidGrantAction, recordHumanGrant } from "../../../../lib/contract-human-grants";

export async function onRequestPost(context: TenantCommandContext) {
  try {
    const command = await readOwnerCommand(context, "human_grant");
    if (command instanceof Response) return command;
    const { access, data: d } = command;
    if (!d || typeof d !== "object" || !("grantId" in d)) return commandError(400, "invalid_human_grant");
    const { grantId, ...terms } = d;
    const review = parseGrantReview(terms);
    if (typeof grantId !== "string" || !routeId.test(grantId) || !review) return commandError(400, "invalid_human_grant");
    const result = await recordHumanGrant(access, { grantId, ...review });
    if (!result) return commandError(409, "human_grant_not_recorded");
    return jsonResponse({ ok: true, grant: result.grant }, { status: result.replay ? 200 : 201 });
  } catch (error) {
    if (error instanceof InvalidGrantAction) return commandError(400, "invalid_human_grant");
    return commandError(503, "control_storage_unavailable");
  }
}
