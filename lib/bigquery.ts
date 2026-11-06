import { validateBigQuerySql, type SafetyCheck } from "./copilot-engine";
import { fetchOAuthJson } from "./oauth-provider-json";
import { readBoundedProviderJson, withProviderDeadline } from "./provider-response";
import {
  estimateDryRun,
  getGateLabel,
  type QueryRunPreview,
  type QueryRunStatus
} from "./phase2";

export type BigQueryEnv = {
  GATEWAY_MODE?: "demo" | "production";
  BIGQUERY_PROJECT_ID?: string;
  BIGQUERY_CLIENT_EMAIL?: string;
  BIGQUERY_PRIVATE_KEY?: string;
  BIGQUERY_LOCATION?: string;
  BIGQUERY_MAX_BYTES_BILLED?: string;
  BIGQUERY_DRY_RUN_MODE?: "live" | "simulated";
};

export type BigQueryDryRunResult = QueryRunPreview & {
  mode: "live" | "simulated";
  configured: boolean;
};

export type BigQueryQueryRow = Record<string, string | number | boolean | null>;

export type BigQueryQueryResult =
  | {
      ok: true;
      rows: BigQueryQueryRow[];
      totalRows: number;
      jobReference?: {
        projectId?: string;
        location?: string;
      };
    }
  | {
      ok: false;
      code: string;
      message: string;
    };

type BigQueryJobResponse = {
  jobReference?: {
    projectId?: string;
    location?: string;
  };
  statistics?: {
    totalBytesProcessed?: string;
    query?: {
      totalBytesProcessed?: string;
    };
  };
};

type BigQueryQueryResponse = {
  schema?: {
    fields?: Array<{
      name?: string;
      type?: string;
    }>;
  };
  rows?: Array<{
    f?: Array<{
      v?: unknown;
    }>;
  }>;
  totalRows?: string;
  pageToken?: string;
  jobComplete?: boolean;
  jobReference?: {
    projectId?: string;
    location?: string;
  };
  errors?: Array<{
    reason?: string;
    message?: string;
  }>;
};

type GoogleTokenResponse = {
  access_token?: unknown;
};

const encoder = new TextEncoder();
const BIGQUERY_COST_PER_TIB = 5;
const BYTES_PER_TIB = 1024 ** 4;
const BIGQUERY_TOKEN_AUDIENCE = "https://oauth2.googleapis.com/token";
const BIGQUERY_SCOPE = "https://www.googleapis.com/auth/bigquery";

type DryRunTransport =
  | { mode: "live"; message: string }
  | { mode: "blocked" | "simulated"; code: string; message: string };

export function resolveDryRunTransport(env: BigQueryEnv): DryRunTransport {
  const gateway = env.GATEWAY_MODE, preview = env.BIGQUERY_DRY_RUN_MODE;
  if (gateway !== undefined && gateway !== "demo" && gateway !== "production")
    return { mode: "blocked", code: "invalid_gateway_mode", message: "Unrecognized gateway mode." };
  if (preview !== undefined && preview !== "live" && preview !== "simulated")
    return { mode: "blocked", code: "invalid_dry_run_mode", message: "Unrecognized dry-run mode." };
  const configured = hasBigQueryCredentials(env);
  if (gateway === "production" && (!configured || preview === "simulated"))
    return { mode: "blocked", code: "production_not_configured", message: "Production requires configured live previews." };
  // No trusted tenant-to-table binding accompanies raw editor SQL. Only an
  // independently scoped, server-compiled operation could run in production.
  if (gateway === "production")
    return { mode: "blocked", code: "production_preview_scope_unbound", message: "The raw SQL preview cannot establish tenant table access." };
  if (preview === "simulated")
    return { mode: "simulated", code: "bigquery_simulated_mode", message: "BigQuery dry-run is forced to simulated mode." };
  if (!configured)
    return { mode: "simulated", code: "bigquery_not_configured", message: "BigQuery credentials are missing; dry-run uses simulated estimates." };
  if (gateway === undefined)
    return { mode: "blocked", code: "gateway_mode_required", message: "Live previews require an explicit gateway mode." };
  return { mode: "live", message: "Live BigQuery dry-run transport is configured." };
}

export async function runBigQueryDryRun(
  sql: string,
  env: BigQueryEnv
): Promise<BigQueryDryRunResult> {
  const configured = hasBigQueryCredentials(env);
  const simulated = createSimulatedDryRun(sql, configured);

  const transport = resolveDryRunTransport(env);
  if (transport.mode === "blocked")
    return { ...simulated, status: "blocked", gateLabel: getGateLabel("blocked"),
      error: { code: transport.code, message: transport.message } };

  if (hasBlockingPreflight(simulated.checks)) {
    return {
      ...simulated,
      error: {
        code: "blocked_before_bigquery",
        message: "Safety preflight blocked this query before BigQuery dry-run."
      }
    };
  }

  if (transport.mode === "simulated")
    return { ...simulated, error: { code: transport.code, message: transport.message } };

  try {
    const accessToken = await createBigQueryAccessToken(env);
    const response = await fetchBigQueryJson(createJobsInsertUrl(env.BIGQUERY_PROJECT_ID),
      accessToken, createDryRunJobRequest(sql, env));

    if (!response.ok) {
      return createFailedLiveDryRun(sql, env, response.error);
    }

    const job = response.value as BigQueryJobResponse;
    const scannedBytes = getProcessedBytes(job);
    const checks = withLiveCostCheck(validateBigQuerySql(sql), scannedBytes, env);
    const status = getDryRunStatus(checks);

    return {
      ...simulated,
      mode: "live",
      configured: true,
      status,
      gateLabel: getGateLabel(status),
      scannedBytes,
      estimatedCostUsd: estimateBigQueryCostUsd(scannedBytes),
      expectedRuntimeMs: estimateRuntimeMs(scannedBytes),
      checks,
      jobReference: job.jobReference
    };
  } catch {
    return createFailedLiveDryRun(sql, env, {
      code: "bigquery_request_failed",
      message: "BigQuery request failed."
    });
  }
}

export async function runBigQueryQuery(
  sql: string,
  env: BigQueryEnv
): Promise<BigQueryQueryResult> {
  // This legacy queries API has no contract, budget reservation or receipt.
  if (env.GATEWAY_MODE !== "demo") {
    return {
      ok: false,
      code: "legacy_query_disabled",
      message: "Legacy schema import is available only in explicit demo mode."
    };
  }
  if (!hasBigQueryCredentials(env)) {
    return {
      ok: false,
      code: "bigquery_not_configured",
      message:
        "BigQuery service account credentials are required for schema import."
    };
  }

  try {
    const accessToken = await createBigQueryAccessToken(env);
    const response = await fetchBigQueryJson(createQueriesUrl(env.BIGQUERY_PROJECT_ID),
      accessToken, createQueryRequest(sql, env));

    if (!response.ok) {
      return { ok: false, ...response.error };
    }

    const query = response.value as BigQueryQueryResponse;
    if (query.jobComplete === false) {
      return {
        ok: false,
        code: "bigquery_query_incomplete",
        message:
          "BigQuery schema import query did not finish within the request timeout."
      };
    }

    if (query.errors?.length) {
      return {
        ok: false,
        code: "bigquery_query_error",
        message: "BigQuery query failed."
      };
    }

    if (query.jobComplete !== true ||
        (query.pageToken !== undefined && typeof query.pageToken !== "string")) {
      throw new Error("Invalid query completion metadata.");
    }
    if (query.pageToken) {
      return { ok: false, code: "bigquery_query_incomplete",
        message: "BigQuery schema import requires a complete single-page result." };
    }
    const rows = parseBigQueryRows(query);
    if (typeof query.totalRows !== "string" || !/^(0|[1-9][0-9]*)$/.test(query.totalRows) ||
        !Number.isSafeInteger(Number(query.totalRows)) || Number(query.totalRows) !== rows.length) {
      throw new Error("Invalid query row count.");
    }

    return {
      ok: true,
      rows,
      totalRows: rows.length,
      jobReference: query.jobReference
    };
  } catch {
    return {
      ok: false,
      code: "bigquery_query_failed",
      message: "BigQuery query failed."
    };
  }
}

export function hasBigQueryCredentials(env: BigQueryEnv) {
  return Boolean(
    env.BIGQUERY_PROJECT_ID &&
      env.BIGQUERY_CLIENT_EMAIL &&
      env.BIGQUERY_PRIVATE_KEY
  );
}

export function normalizeBigQueryPrivateKey(privateKey: string) {
  return privateKey.replace(/\\n/g, "\n").trim();
}

function createSimulatedDryRun(
  sql: string,
  configured: boolean
): BigQueryDryRunResult {
  const preview = estimateDryRun(sql);

  return {
    ...preview,
    mode: "simulated",
    configured
  };
}

function createFailedLiveDryRun(
  sql: string,
  env: BigQueryEnv,
  error: { code: string; message: string }
): BigQueryDryRunResult {
  const preview = estimateDryRun(sql);
  const checks = validateBigQuerySql(sql);

  return {
    ...preview,
    mode: "live",
    configured: true,
    status: "blocked",
    gateLabel: "Blocked by BigQuery dry run",
    scannedBytes: 0,
    estimatedCostUsd: 0,
    expectedRuntimeMs: 0,
    checks,
    jobReference: {
      projectId: env.BIGQUERY_PROJECT_ID,
      location: env.BIGQUERY_LOCATION
    },
    error
  };
}

function hasBlockingPreflight(checks: SafetyCheck[]) {
  return checks.some(
    (check) =>
      check.status === "warn" && check.label === "No destructive operations"
  );
}

function getDryRunStatus(checks: SafetyCheck[]): QueryRunStatus {
  if (hasBlockingPreflight(checks)) {
    return "blocked";
  }

  if (checks.some((check) => check.status === "warn")) {
    return "needs_approval";
  }

  return "approved";
}

function withLiveCostCheck(
  checks: SafetyCheck[],
  scannedBytes: number,
  env: BigQueryEnv
) {
  const maxBytes = parseMaxBytesBilled(env.BIGQUERY_MAX_BYTES_BILLED);
  const costWithinLimit = maxBytes === null || scannedBytes <= maxBytes;

  return checks.map((check) => {
    if (check.label !== "Cost within limits") {
      return check;
    }

    return {
      label: check.label,
      detail: costWithinLimit
        ? `BigQuery dry-run estimates ${formatRawBytes(scannedBytes)} scanned.`
        : `BigQuery dry-run estimates ${formatRawBytes(
            scannedBytes
          )}, above the configured ${formatRawBytes(maxBytes)} limit.`,
      status: costWithinLimit && check.status === "pass" ? "pass" : "warn"
    } satisfies SafetyCheck;
  });
}

function parseMaxBytesBilled(value: string | undefined) {
  if (!value) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function createDryRunJobRequest(sql: string, env: BigQueryEnv) {
  const query: Record<string, unknown> = {
    query: sql,
    useLegacySql: false
  };

  if (env.BIGQUERY_MAX_BYTES_BILLED) {
    query.maximumBytesBilled = env.BIGQUERY_MAX_BYTES_BILLED;
  }

  return {
    configuration: {
      dryRun: true,
      query
    },
    jobReference: {
      projectId: env.BIGQUERY_PROJECT_ID,
      ...(env.BIGQUERY_LOCATION ? { location: env.BIGQUERY_LOCATION } : {})
    }
  };
}

function createQueryRequest(sql: string, env: BigQueryEnv) {
  const query: Record<string, unknown> = {
    query: sql,
    useLegacySql: false,
    useQueryCache: false,
    timeoutMs: 30_000,
    maxResults: 10_000
  };

  if (env.BIGQUERY_LOCATION) {
    query.location = env.BIGQUERY_LOCATION;
  }

  if (env.BIGQUERY_MAX_BYTES_BILLED) {
    query.maximumBytesBilled = env.BIGQUERY_MAX_BYTES_BILLED;
  }

  return query;
}

export async function createBigQueryAccessToken(env: BigQueryEnv) {
  try {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const assertion = await signJwt(
      {
        alg: "RS256",
        typ: "JWT"
      },
      {
        iss: env.BIGQUERY_CLIENT_EMAIL,
        scope: BIGQUERY_SCOPE,
        aud: BIGQUERY_TOKEN_AUDIENCE,
        iat: nowSeconds,
        exp: nowSeconds + 3600
      },
      env.BIGQUERY_PRIVATE_KEY ?? ""
    );
    const tokenResponse = await fetchOAuthJson(BIGQUERY_TOKEN_AUDIENCE, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion
      })
    }) as GoogleTokenResponse | null;
    const token = tokenResponse?.access_token;
    if (typeof token !== "string" || !/^[\x21-\x7e]+$/.test(token)) {
      throw new Error("Invalid access token");
    }
    return token;
  } catch {
    // Neither upstream errors nor key/parser failures are safe public diagnostics.
    throw new Error("Google OAuth token exchange failed.");
  }
}

async function signJwt(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  privateKey: string
) {
  const signingInput = `${base64UrlEncodeJson(header)}.${base64UrlEncodeJson(
    payload
  )}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(normalizeBigQueryPrivateKey(privateKey)),
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256"
    },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    encoder.encode(signingInput)
  );

  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

function createJobsInsertUrl(projectId: string | undefined) {
  return `https://bigquery.googleapis.com/bigquery/v2/projects/${encodeURIComponent(
    projectId ?? ""
  )}/jobs`;
}

function createQueriesUrl(projectId: string | undefined) {
  return `https://bigquery.googleapis.com/bigquery/v2/projects/${encodeURIComponent(
    projectId ?? ""
  )}/queries`;
}

function getProcessedBytes(job: BigQueryJobResponse) {
  const value =
    job.statistics?.query?.totalBytesProcessed ??
    job.statistics?.totalBytesProcessed;
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error("Missing or invalid dry-run byte estimate.");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error("Dry-run byte estimate exceeds supported range.");
  return parsed;
}

function estimateBigQueryCostUsd(scannedBytes: number) {
  return Number(((scannedBytes / BYTES_PER_TIB) * BIGQUERY_COST_PER_TIB).toFixed(4));
}

function estimateRuntimeMs(scannedBytes: number) {
  const scannedMb = scannedBytes / (1024 * 1024);
  return Math.round(850 + Math.min(scannedMb * 4.5, 45_000));
}

async function fetchBigQueryJson(url: string, accessToken: string, body: Record<string, unknown>) {
  return withProviderDeadline(async signal => {
    const response = await fetch(url, {
      method: "POST", redirect: "manual", signal,
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (signal.aborted) {
      void response.body?.cancel().catch(() => {});
      throw new Error("BigQuery request failed.");
    }
    if (!response.ok || response.redirected) {
      return { ok: false, error: createGoogleApiError(response) } as const;
    }
    const value = await readBoundedProviderJson(response, signal);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Invalid BigQuery response.");
    }
    return { ok: true, value } as const;
  }, "BigQuery request failed.");
}

function createGoogleApiError(response: Response) {
  // Provider bodies and status text can contain credentials, SQL or private metadata.
  void response.body?.cancel().catch(() => {});
  if (response.redirected || (response.status >= 300 && response.status < 400)) {
    return { code: "bigquery_redirect_refused", message: "BigQuery redirects are not permitted." };
  }
  return { code: `http_${response.status}`, message: `BigQuery request failed (HTTP ${response.status}).` };
}

function parseBigQueryRows(query: BigQueryQueryResponse): BigQueryQueryRow[] {
  const rows = query.rows === undefined ? [] : query.rows;
  const fields = query.schema === undefined ? [] : query.schema?.fields;
  if (!Array.isArray(rows) || !Array.isArray(fields) || (rows.length > 0 && fields.length === 0)) {
    throw new Error("Invalid query rows or schema.");
  }
  const names = fields.map(field => {
    if (!field || typeof field.name !== "string" || !field.name.trim()) {
      throw new Error("Invalid query field name.");
    }
    return field.name;
  });
  if (new Set(names).size !== names.length) throw new Error("Duplicate query field name.");

  return rows.map(row => {
    if (!row || !Array.isArray(row.f) || row.f.length !== names.length) {
      throw new Error("Invalid query cells.");
    }
    // Do not silently drop duplicate columns or turn missing cells into SQL NULL.
    return Object.fromEntries(row.f.map((cell, index) => {
      if (!cell || typeof cell !== "object" || !Object.hasOwn(cell, "v")) {
        throw new Error("Invalid query cell.");
      }
      return [names[index], normalizeBigQueryValue(cell.v)];
    }));
  });
}

function normalizeBigQueryValue(value: unknown) {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  ) {
    return value;
  }

  if (typeof value === "undefined") {
    return null;
  }

  return JSON.stringify(value);
}

function pemToArrayBuffer(pem: string) {
  const body = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s/g, "");

  if (!body || /BEGIN RSA PRIVATE KEY/.test(pem)) {
    throw new Error("BIGQUERY_PRIVATE_KEY must be a PKCS#8 private key.");
  }

  return base64ToBytes(body).buffer;
}

function base64UrlEncodeJson(value: Record<string, unknown>) {
  return base64UrlEncode(encoder.encode(JSON.stringify(value)));
}

function base64UrlEncode(bytes: Uint8Array) {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64ToBytes(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

function formatRawBytes(bytes: number) {
  if (bytes >= 1024 ** 3) {
    return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  }

  if (bytes >= 1024 ** 2) {
    return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  }

  return `${bytes} bytes`;
}
