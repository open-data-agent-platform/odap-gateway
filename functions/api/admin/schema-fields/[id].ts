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

type SchemaFieldPolicyBody = {
  queryable?: unknown;
  pii?: unknown;
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
    schemaField: result.value
  });
}

async function readJsonBody(
  request: Request
): Promise<
  | { ok: true; value: SchemaFieldPolicyBody }
  | { ok: false; code: string; message: string }
> {
  try {
    const value = (await request.json()) as unknown;
    if (!isRecord(value)) {
      return {
        ok: false,
        code: "invalid_json",
        message: "Request body must be a JSON object."
      };
    }

    return {
      ok: true,
      value
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
