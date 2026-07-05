import {
  jsonResponse,
  requireAdminSession
} from "../../../lib/auth-request";
import {
  queueRollback,
  type AdminStorageEnv
} from "../../../lib/admin-store";
import { type AuthEnv } from "../../../lib/auth";

type RollbackContext = {
  request: Request;
  env: AuthEnv & AdminStorageEnv;
};

export async function onRequestPost(context: RollbackContext) {
  const auth = await requireAdminSession(context.request, context.env);
  if (!auth.ok) {
    return auth.response;
  }

  const result = await queueRollback(context.env, auth.session.email);
  if (!result.ok) {
    return jsonResponse(
      {
        ok: false,
        code: result.code,
        message: result.message
      },
      { status: result.status }
    );
  }

  return jsonResponse({
    ok: true,
    rollback: result.value
  });
}
