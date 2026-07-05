import {
  jsonResponse,
  requireAdminSession
} from "../../../../lib/auth-request";
import { type AuthEnv, type AuthRole } from "../../../../lib/auth";
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

type AdminUserPatchBody = {
  role?: unknown;
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

  const body = await readJsonBody(context.request);
  if (!body.ok) {
    return jsonResponse(
      {
        ok: false,
        code: body.code,
        message: body.message
      },
      { status: 400 }
    );
  }

  const result = await updateAdminUserRole(
    context.env,
    id,
    body.value.role,
    auth.session.email
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

async function readJsonBody(
  request: Request
): Promise<
  | { ok: true; value: { role: AuthRole } }
  | { ok: false; code: string; message: string }
> {
  try {
    const value = (await request.json()) as AdminUserPatchBody;
    if (!isRecord(value)) {
      return {
        ok: false,
        code: "invalid_json",
        message: "Request body must be a JSON object."
      };
    }

    if (value.role !== "admin" && value.role !== "member") {
      return {
        ok: false,
        code: "invalid_user_role",
        message: "User role must be admin or member."
      };
    }

    return {
      ok: true,
      value: {
        role: value.role
      }
    };
  } catch {
    return {
      ok: false,
      code: "invalid_json",
      message: "Request body must be valid JSON."
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
