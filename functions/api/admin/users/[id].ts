import {
  jsonResponse,
  requireAdminSession
} from "../../../../lib/auth-request";
import { type AuthEnv } from "../../../../lib/auth";
import { readAdminJsonBody } from "../../../../lib/admin-command-request";
import {
  updateAdminUserRole,
  type AdminStorageEnv
} from "../../../../lib/admin-store";

type AdminUserContext = {
  request: Request;
  env: AuthEnv & AdminStorageEnv;
  params: {
    id?: string;
  };
};

export async function onRequestPatch(context: AdminUserContext) {
  const auth = await requireAdminSession(context.request, context.env);
  if (!auth.ok) {
    return auth.response;
  }

  const id = context.params.id ? decodeURIComponent(context.params.id) : "";
  if (!id.trim()) {
    return jsonResponse(
      {
        ok: false,
        code: "admin_user_id_required",
        message: "Admin user id is required."
      },
      { status: 400 }
    );
  }

  const body = await readAdminJsonBody(context.request);
  if (!body.ok) {
    return jsonResponse(
      {
        ok: false,
        code: body.code,
        message: body.message
      },
      { status: body.status }
    );
  }

  if (body.value.role !== "admin" && body.value.role !== "member") {
    return jsonResponse({ ok: false, code: "invalid_user_role",
      message: "User role must be admin or member." }, { status: 400 });
  }

  const result = await updateAdminUserRole(
    context.env,
    id,
    body.value.role,
    auth.session
  );

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
    user: result.value
  });
}
