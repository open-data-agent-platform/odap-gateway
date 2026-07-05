import {
  jsonResponse,
  requireAdminSession
} from "../../../lib/auth-request";
import {
  getAdminState,
  type AdminRuntimeEnv
} from "../../../lib/admin-store";
import { getPublicSession, type AuthEnv } from "../../../lib/auth";

type AdminStateContext = {
  request: Request;
  env: AuthEnv & AdminRuntimeEnv;
};

export async function onRequestGet(context: AdminStateContext) {
  const auth = await requireAdminSession(context.request, context.env);
  if (!auth.ok) {
    return auth.response;
  }

  const state = await getAdminState(context.env);

  return jsonResponse({
    ok: true,
    user: getPublicSession(auth.session),
    state
  });
}
