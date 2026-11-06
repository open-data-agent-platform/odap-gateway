import {
  jsonResponse,
  requireAdminSession
} from "../../../lib/auth-request";
import { type AuthEnv } from "../../../lib/auth";
import { type AdminStorageEnv } from "../../../lib/admin-store";

type RollbackContext = {
  request: Request;
  env: AuthEnv & AdminStorageEnv;
};

export async function onRequestPost(context: RollbackContext) {
  const auth = await requireAdminSession(context.request, context.env);
  if (!auth.ok) {
    return auth.response;
  }

  // An audit entry is not an executable deployment rollback.
  return jsonResponse({
    ok: false,
    code: "rollback_not_supported",
    message: "Deployment rollback is not implemented. No rollback was queued or executed."
  }, { status: 501 });
}
