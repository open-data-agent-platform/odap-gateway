import { readAdminJsonBody } from "../../../../lib/admin-command-request";
import {
  jsonResponse,
  requireAdminSession
} from "../../../../lib/auth-request";
import {
  updateSchemaFieldPolicy,
  type AdminStorageEnv
} from "../../../../lib/admin-store";
import { type AuthEnv } from "../../../../lib/auth";

type SchemaFieldContext = {
  request: Request;
  env: AuthEnv & AdminStorageEnv;
  params: {
    id?: string;
  };
};

export async function onRequestPatch(context: SchemaFieldContext) {
  const auth = await requireAdminSession(context.request, context.env);
  if (!auth.ok) {
    return auth.response;
  }

  const id = context.params.id?.trim();
  if (!id) {
    return jsonResponse(
      {
        ok: false,
        code: "schema_field_id_required",
        message: "Schema field id is required."
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

  const policy = {
    queryable:
      typeof body.value.queryable === "boolean"
        ? body.value.queryable
        : undefined,
    pii: typeof body.value.pii === "boolean" ? body.value.pii : undefined
  };

  const result = await updateSchemaFieldPolicy(
    context.env,
    id,
    policy,
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
    schemaField: result.value
  });
}
