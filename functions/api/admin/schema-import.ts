import { readAdminJsonBody } from "../../../lib/admin-command-request";
import {
  jsonResponse,
  requireAdminSession
} from "../../../lib/auth-request";
import { type AuthEnv } from "../../../lib/auth";
import {
  importBigQuerySchemaCatalog,
  type BigQuerySchemaImportInput
} from "../../../lib/schema-import";
import type { AdminRuntimeEnv } from "../../../lib/admin-store";

type SchemaImportContext = {
  request: Request;
  env: AuthEnv & AdminRuntimeEnv;
};

export async function onRequestPost(context: SchemaImportContext) {
  const auth = await requireAdminSession(context.request, context.env);
  if (!auth.ok) {
    return auth.response;
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

  const input = {
    workspace: getString(body.value.workspace),
    dataset: getString(body.value.dataset),
    projectId: getOptionalString(body.value.projectId),
    tablePrefix: getOptionalString(body.value.tablePrefix),
    tableLimit: getOptionalInteger(body.value.tableLimit)
  } satisfies BigQuerySchemaImportInput;
  const result = await importBigQuerySchemaCatalog(
    context.env,
    input,
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
    import: result.value
  });
}

function getString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function getOptionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function getOptionalInteger(value: unknown) {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);

    return Number.isInteger(parsed) ? parsed : undefined;
  }

  return undefined;
}
