import {
  getSessionFromRequest,
  jsonResponse
} from "../../../lib/auth-request";
import { type AuthEnv } from "../../../lib/auth";
import {
  getAdminDb,
  recordQueryDryRun,
  type AdminStorageEnv
} from "../../../lib/admin-store";
import {
  runBigQueryDryRun,
  resolveDryRunTransport,
  type BigQueryEnv
} from "../../../lib/bigquery";
import { estimateDryRun } from "../../../lib/phase2";
import { readBoundedRequestJson } from "../../../lib/request-json";
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
// Accommodate the SQL limit even when every character uses a six-byte JSON escape.
const MAX_BODY_BYTES = 128 * 1024;

export async function onRequestPost(context: QueryDryRunContext) {
  const transport = resolveDryRunTransport(context.env);
  const session = await getSessionFromRequest(context.request, context.env);
  if (!session && (context.env.GATEWAY_MODE === "production" || transport.mode === "live"))
    return jsonResponse({ ok: false, code: "unauthenticated" }, { status: 401 });
  if (context.env.GATEWAY_MODE === "production" && !(context.env.ODAP_GATEWAY_DB ?? context.env.DB))
    return jsonResponse({ ok: false, code: "production_not_configured" }, { status: 503 });
  if (transport.mode === "blocked")
    return jsonResponse({ ok: false, code: transport.code }, { status: transport.code === "production_preview_scope_unbound" ? 403 : 503 });
  const storage = getAdminDb(context.env);
  if (storage && typeof storage.db.batch !== "function") {
    return jsonResponse({
      ok: false,
      code: "dry_run_history_transaction_unavailable",
      message: "Transactional storage is required for dry-run history."
    }, { status: 503 });
  }
  const body = await readJsonBody(context.request);
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
  | { ok: false; status: number; code: string; message: string }
> {
  const body = await readBoundedRequestJson(request, MAX_BODY_BYTES);
  if (!body.ok) {
    if (body.reason === "too_large") return { ok: false, status: 413,
      code: "dry_run_body_too_large", message: "Dry-run body exceeds the 128 KiB limit." };
    if (body.reason === "timeout") return { ok: false, status: 408,
      code: "dry_run_body_timeout", message: "Dry-run body did not arrive in time." };
    return {
      ok: false, status: 400,
      code: "invalid_json",
      message: "Request body must be valid JSON."
    };
  }
  if (!isRecord(body.value)) return { ok: false, status: 400,
    code: "invalid_json", message: "Request body must be a JSON object." };
  return { ok: true, value: body.value };
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
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
