import { jsonResponse } from "../../../../lib/auth-request";
import { commandError, parseGrantReview, readOwnerCommand, type TenantCommandContext } from "../../../../lib/control-command-request";
import { InvalidGrantAction, reviewHumanGrant } from "../../../../lib/contract-human-grants";

export async function onRequestPost(context: TenantCommandContext) {
  try {
    const command = await readOwnerCommand(context, "human_grant_review");
    if (command instanceof Response) return command;
    const terms = parseGrantReview(command.data);
    if (!terms) return commandError(400, "invalid_human_grant_review");
    const review = await reviewHumanGrant(command.access, terms);
    if (!review) return commandError(404, "grant_review_unavailable");
    return jsonResponse({ ok: true, review: { state: "matched", ...review } });
  } catch (error) {
    if (error instanceof InvalidGrantAction) return commandError(400, "invalid_reviewed_action");
    return commandError(503, "control_storage_unavailable");
  }
}
