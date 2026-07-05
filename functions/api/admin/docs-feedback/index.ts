import {
  jsonResponse,
  requireAdminSession
} from "../../../../lib/auth-request";
import { type AuthEnv } from "../../../../lib/auth";
import {
  listAdminDocsFeedback,
  type DocsFeedbackEnv
} from "../../../../lib/docs-feedback";

type DocsFeedbackAdminContext = {
  request: Request;
  env: AuthEnv & DocsFeedbackEnv;
};

export async function onRequestGet(context: DocsFeedbackAdminContext) {
  const auth = await requireAdminSession(context.request, context.env);
  if (!auth.ok) {
    return auth.response;
  }

  const result = await listAdminDocsFeedback(context.env);

  return jsonResponse({
    ok: true,
    feedback: result.feedback,
    persisted: result.persisted,
    storageBinding: result.storageBinding
  });
}
