import {
  getSessionFromRequest,
  jsonResponse
} from "../../../lib/auth-request";
import { type AuthEnv } from "../../../lib/auth";
import {
  recordQueryDryRun,
  type AdminStorageEnv
} from "../../../lib/admin-store";
import {
  runBigQueryDryRun,
  hasBigQueryCredentials,
  type BigQueryEnv
} from "../../../lib/bigquery";
import { estimateDryRun } from "../../../lib/phase2";
import {
  applySchemaPolicyToDryRunPreview,
  evaluateSchemaPolicy
} from "../../../lib/schema-policy";

type QueryDryRunContext = {
  request: Request;
  env: AuthEnv & AdminStorageEnv & BigQueryEnv;
};

type QueryDryRunBody = {
  sql?: unknown;
  workspace?: unknown;
  queryType?: unknown;
};

const MAX_SQL_LENGTH = 20_000;

export async function onRequestPost(context: QueryDryRunContext) {
  if (context.env.GATEWAY_MODE && !["demo", "production"].includes(context.env.GATEWAY_MODE)) {
    return jsonResponse({ ok: false, code: "invalid_gateway_mode" }, { status: 503 });
  }
  const session = await getSessionFromRequest(context.request, context.env);
  if (context.env.GATEWAY_MODE === "production") {
    if (!session) return jsonResponse({ ok: false, code: "unauthenticated" }, { status: 401 });
    if (!hasBigQueryCredentials(context.env) || context.env.BIGQUERY_DRY_RUN_MODE === "simulated" ||
      !(context.env.ODAP_GATEWAY_DB ?? context.env.DB)) {
      return jsonResponse({ ok: false, code: "production_not_configured" }, { status: 503 });
    }
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

  const sql = getString(body.value.sql).trim();
  if (!sql) {
    return jsonResponse(
      {
        ok: false,
        code: "sql_required",
        message: "SQL is required for dry-run."
      },
      { status: 400 }
    );
  }

  if (sql.length > MAX_SQL_LENGTH) {
    return jsonResponse(
      {
        ok: false,
        code: "sql_too_large",
        message: `SQL must be ${MAX_SQL_LENGTH} characters or less.`
      },
      { status: 400 }
    );
  }

  const workspace = getString(body.value.workspace) || inferWorkspace(sql);
  const queryType = getString(body.value.queryType) || "Generated Query";
  const policyEvaluation = await evaluateSchemaPolicy(context.env, {
    sql,
    workspace
  });
  const basePreview = policyEvaluation.blocked
    ? estimateDryRun(sql)
    : await runBigQueryDryRun(sql, context.env);
  const preview = applySchemaPolicyToDryRunPreview(
    basePreview,
    policyEvaluation
  );
  if (context.env.GATEWAY_MODE === "production" && (policyEvaluation.blocked || basePreview.mode !== "live" || basePreview.error)) {
    return jsonResponse({ ok: false, code: policyEvaluation.blocked ? "policy_blocked" : "live_preview_required", preview },
      { status: policyEvaluation.blocked ? 403 : 503 });
  }
  const record = await recordQueryDryRun(context.env, {
    workspace,
    queryType,
    actorEmail: session?.email,
    sql,
    preview
  });
  const enrichedPreview = {
    ...preview,
    runId: record.id,
    persisted: record.persisted
  };
  if (context.env.GATEWAY_MODE === "production" && !record.persisted) {
    return jsonResponse({ ok: false, code: "preview_persistence_failed" }, { status: 503 });
  }

  return jsonResponse({
    ok: true,
    preview: enrichedPreview,
    runId: record.id,
    persisted: record.persisted,
    storageBinding: record.storageBinding,
    user: session
      ? {
          email: session.email,
          name: session.name,
          role: session.role ?? "member"
        }
      : null
  });
}

async function readJsonBody(
  request: Request
): Promise<
  | { ok: true; value: QueryDryRunBody }
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

function inferWorkspace(sql: string) {
  const match = stripExtractExpressions(sql).match(
    /\b(?:FROM|JOIN)\s+`?([\w.-]+)`?/i
  );
  const tableName = match?.[1];
  if (!tableName) {
    return "demo";
  }

  const parts = tableName.split(".");
  return (parts.length > 1 ? parts.at(-2) : parts[0])?.toLowerCase() ?? "demo";
}

function stripExtractExpressions(sql: string) {
  return sql.replace(/\bEXTRACT\s*\([^)]*\bFROM\b[^)]*\)/gi, " ");
}

function getString(value: unknown) {
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
