import { validateGoogleSql, type SafetyCheck } from "./copilot-engine";
import {
  estimateDryRun,
  getGateLabel,
  type QueryRunPreview,
  type QueryRunStatus
} from "./phase2";

export type BigQueryEnv = {
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
  access_token?: string;
  error?: string;
  error_description?: string;
};

type GoogleApiErrorResponse = {
  error?: {
    code?: number;
    message?: string;
    status?: string;
  };
};

const encoder = new TextEncoder();
const BIGQUERY_COST_PER_TIB = 5;
const BYTES_PER_TIB = 1024 ** 4;
const BIGQUERY_TOKEN_AUDIENCE = "https://oauth2.googleapis.com/token";
const BIGQUERY_SCOPE = "https://www.googleapis.com/auth/bigquery";

export async function runBigQueryDryRun(
  sql: string,
  env: BigQueryEnv
): Promise<BigQueryDryRunResult> {
  const configured = hasBigQueryCredentials(env);
  const simulated = createSimulatedDryRun(sql, configured);

  if (env.BIGQUERY_DRY_RUN_MODE === "simulated") {
    return {
      ...simulated,
      error: {
        code: "bigquery_simulated_mode",
        message: "BigQuery dry-run is forced to simulated mode."
      }
    };
  }

  if (hasBlockingPreflight(simulated.checks)) {
    return {
      ...simulated,
      error: {
        code: "blocked_before_bigquery",
        message: "Safety preflight blocked this query before BigQuery dry-run."
      }
    };
  }

  if (!configured) {
    return {
      ...simulated,
      error: {
        code: "bigquery_not_configured",
        message:
          "BigQuery service account credentials are not configured; using simulated dry-run."
      }
    };
  }

  try {
    const accessToken = await createBigQueryAccessToken(env);
    const response = await fetch(createJobsInsertUrl(env.BIGQUERY_PROJECT_ID), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(createDryRunJobRequest(sql, env))
    });

    if (!response.ok) {
      return createFailedLiveDryRun(sql, env, await parseGoogleApiError(response));
    }

    const job = (await response.json()) as BigQueryJobResponse;
    const scannedBytes = getProcessedBytes(job);
    const checks = withLiveCostCheck(validateGoogleSql(sql), scannedBytes, env);
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
  } catch (error) {
    return createFailedLiveDryRun(sql, env, {
      code: "bigquery_request_failed",
      message: error instanceof Error ? error.message : "BigQuery request failed."
    });
  }
}

export async function runBigQueryQuery(
  sql: string,
  env: BigQueryEnv
): Promise<BigQueryQueryResult> {
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
    const response = await fetch(createQueriesUrl(env.BIGQUERY_PROJECT_ID), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(createQueryRequest(sql, env))
    });

    if (!response.ok) {
      const error = await parseGoogleApiError(response);

      return {
        ok: false,
        code: error.code,
        message: error.message
      };
    }

    const query = (await response.json()) as BigQueryQueryResponse;
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
        code: query.errors[0]?.reason ?? "bigquery_query_error",
        message: query.errors[0]?.message ?? "BigQuery query failed."
      };
    }

    return {
      ok: true,
      rows: parseBigQueryRows(query),
      totalRows: Number(query.totalRows ?? query.rows?.length ?? 0),
      jobReference: query.jobReference
    };
  } catch (error) {
    return {
      ok: false,
      code: "bigquery_query_failed",
      message: error instanceof Error ? error.message : "BigQuery query failed."
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
  const checks = validateGoogleSql(sql);

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
    useLegacySql: false,
    dryRun: true
  };

  if (env.BIGQUERY_MAX_BYTES_BILLED) {
    query.maximumBytesBilled = env.BIGQUERY_MAX_BYTES_BILLED;
  }

  return {
    configuration: {
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

async function createBigQueryAccessToken(env: BigQueryEnv) {
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
  const response = await fetch(BIGQUERY_TOKEN_AUDIENCE, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion
    })
  });
  const tokenResponse = (await response.json()) as GoogleTokenResponse;

  if (!response.ok || !tokenResponse.access_token) {
    throw new Error(
      tokenResponse.error_description ??
        tokenResponse.error ??
        "Google OAuth token exchange failed."
    );
  }

  return tokenResponse.access_token;
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
    job.statistics?.totalBytesProcessed ??
    "0";
  const parsed = Number(value);

  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function estimateBigQueryCostUsd(scannedBytes: number) {
  return Number(((scannedBytes / BYTES_PER_TIB) * BIGQUERY_COST_PER_TIB).toFixed(4));
}

function estimateRuntimeMs(scannedBytes: number) {
  const scannedMb = scannedBytes / (1024 * 1024);
  return Math.round(850 + Math.min(scannedMb * 4.5, 45_000));
}

async function parseGoogleApiError(response: Response) {
  try {
    const body = (await response.json()) as GoogleApiErrorResponse;

    return {
      code: body.error?.status ?? `http_${response.status}`,
      message: body.error?.message ?? response.statusText
    };
  } catch {
    return {
      code: `http_${response.status}`,
      message: response.statusText
    };
  }
}

function parseBigQueryRows(query: BigQueryQueryResponse): BigQueryQueryRow[] {
  const fields = query.schema?.fields ?? [];

  return (query.rows ?? []).map((row) => {
    const record: BigQueryQueryRow = {};

    fields.forEach((field, index) => {
      const name = field.name;
      if (!name) {
        return;
      }

      record[name] = normalizeBigQueryValue(row.f?.[index]?.v);
    });

    return record;
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
