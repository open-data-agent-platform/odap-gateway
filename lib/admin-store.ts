import type { AuthEnv, AuthProvider, AuthSession } from "./auth";
import { getSessionRole, parseAdminEmails, type AuthRole } from "./auth";
import {
  hasBigQueryCredentials,
  resolveDryRunTransport,
  type BigQueryEnv
} from "./bigquery";
import {
  schemaTables,
  type SchemaField,
  type SchemaTable
} from "./demo-data";
import type { D1Database, D1PreparedStatement, D1Result, D1Value } from "./d1";
import {
  phase2FeatureFlags,
  releaseTracks,
  reviewQueue,
  workspaceAllowlist,
  type FeatureFlagStatus,
  type Phase2FeatureFlag,
  type QueryRunPreview,
  type QueryRunStatus,
  type ReleaseEnvironment,
  type ReviewQueueItem,
  type WorkspaceAccess
} from "./phase2";

export type AdminStorageEnv = {
  ODAP_GATEWAY_DB?: D1Database;
  DB?: D1Database;
};


export type AdminRuntimeEnv = AdminStorageEnv &
  BigQueryEnv &
  AuthEnv;

export type StorageMode = "d1" | "seed";

export type AuditEvent = {
  id: string;
  actorEmail: string;
  action: string;
  target: string;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type AdminState = {
  phase: "phase-4";
  generatedAt: string;
  storage: {
    configured: boolean;
    binding: "ODAP_GATEWAY_DB" | "DB" | null;
    mode: StorageMode;
    message: string;
  };
  auth: AuthConfigState;
  bigQuery: BigQueryConfigState;
  users: AdminUserRecord[];
  releaseTracks: typeof releaseTracks;
  featureFlags: Phase2FeatureFlag[];
  reviewQueue: ReviewQueueItem[];
  workspaceAllowlist: WorkspaceAccess[];
  schemaCatalog: SchemaCatalogTable[];
  auditEvents: AuditEvent[];
};

export type AuthConfigState = {
  configured: boolean;
  adminEmails: string[];
  googleConfigured: boolean;
  githubConfigured: boolean;
  cookieSecretConfigured: boolean;
  message: string;
};


export type BigQueryConfigState = {
  configured: boolean;
  mode: "live" | "simulated" | "blocked";
  projectId: string | null;
  location: string | null;
  maxBytesBilled: number | null;
  message: string;
};

export type AdminUserRecord = {
  id: string;
  provider: AuthProvider;
  providerId: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  role: AuthRole;
  lastLoginAt: string;
  createdAt: string;
  updatedAt: string;
};

export type QueryRunDetail = {
  id: string;
  workspace: string;
  actorEmail: string | null;
  sql: string;
  status: QueryRunStatus;
  mode: "live" | "simulated";
  estimatedCostUsd: number;
  scannedBytes: number;
  expectedRuntimeMs: number;
  referencedTables: string[];
  checks: QueryRunPreview["checks"];
  error: QueryRunPreview["error"] | null;
  createdAt: string;
  updatedAt: string;
};

export type SchemaCatalogField = {
  id: string;
  name: string;
  type: string;
  mode: "NULLABLE" | "REQUIRED";
  description: string;
  pii: boolean;
  queryable: boolean;
  usedInExamples: boolean;
  updatedAt: string;
};

export type SchemaCatalogTable = {
  id: string;
  workspace: string;
  name: string;
  description: string;
  rowCount: number;
  updatedAt: string;
  fields: SchemaCatalogField[];
};

export type SchemaImportFieldInput = {
  name: string;
  type: string;
  mode: "NULLABLE" | "REQUIRED";
  description?: string;
  pii?: boolean;
  queryable?: boolean;
  usedInExamples?: boolean;
};

export type SchemaImportTableInput = {
  workspace: string;
  name: string;
  description: string;
  rowCount: number;
  fields: SchemaImportFieldInput[];
};

export type SchemaImportResult = {
  workspace: string;
  importedTables: number;
  importedFields: number;
  importedAt: string;
};

export type UserUpsertResult = {
  persisted: boolean;
  storageBinding: "ODAP_GATEWAY_DB" | "DB" | null;
  role: AuthRole | null;
};

export type QueryRunRecordResult = {
  id: string;
  persisted: boolean;
  storageBinding: "ODAP_GATEWAY_DB" | "DB" | null;
};

export type StoreMutationResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      status: 400 | 403 | 404 | 409 | 500 | 503;
      code: string;
      message: string;
    };

type FeatureFlagRow = {
  id: string;
  name: string;
  description: string;
  status: FeatureFlagStatus;
  environment: ReleaseEnvironment;
  rollout: number;
  owner: string;
  updated_at: string;
};

type WorkspaceRow = {
  workspace: string;
  owner: string;
  plan: WorkspaceAccess["plan"];
  run_access: WorkspaceAccess["runAccess"];
};

type ReviewQueueRow = {
  id: string;
  workspace: string;
  query_type: string;
  status: ReviewQueueItem["status"];
  estimated_cost_usd: number;
  scanned_bytes: number;
  submitted_at: string;
};

type AuditEventRow = {
  id: string;
  actor_email: string;
  action: string;
  target: string;
  metadata_json: string;
  created_at: string;
};

type UserRow = {
  id: string;
  provider: AuthProvider;
  provider_id: string;
  email: string;
  name: string;
  avatar_url: string | null;
  role: AuthRole;
  last_login_at: string;
  created_at: string;
  updated_at: string;
};

type QueryRunRow = {
  id: string;
  workspace: string;
  actor_email: string | null;
  sql: string;
  status: QueryRunStatus;
  mode: "live" | "simulated";
  estimated_cost_usd: number;
  scanned_bytes: number;
  expected_runtime_ms: number;
  referenced_tables_json: string;
  checks_json: string;
  error_json: string | null;
  created_at: string;
  updated_at: string;
};

type SchemaTableRow = {
  id: string;
  workspace: string;
  table_name: string;
  description: string;
  row_count: number;
  updated_at: string;
};

type SchemaFieldRow = {
  id: string;
  table_id: string;
  field_name: string;
  field_type: string;
  mode: "NULLABLE" | "REQUIRED";
  description: string;
  pii: number;
  queryable: number;
  used_in_examples: number;
  updated_at: string;
};

const fallbackAuditEvents: AuditEvent[] = [
  {
    id: "seed-phase4",
    actorEmail: "system@odap.local",
    action: "phase4.seed_state",
    target: "admin-console",
    metadata: {
      reason: "D1 binding is not configured"
    },
    createdAt: "2026-06-20T00:00:00.000Z"
  }
];

const exampleSchemaFields = new Set([
  "order_id",
  "order_date",
  "acquisition_channel",
  "revenue",
  "status",
  "created_at",
  "plan",
  "country",
  "event_time",
  "event_name"
]);

export function getAdminDb(env: AdminStorageEnv) {
  if (env.ODAP_GATEWAY_DB) {
    return {
      db: env.ODAP_GATEWAY_DB,
      binding: "ODAP_GATEWAY_DB" as const
    };
  }

  if (env.DB) {
    return {
      db: env.DB,
      binding: "DB" as const
    };
  }

  return null;
}

export async function getAdminState(env: AdminRuntimeEnv): Promise<AdminState> {
  const configured = getAdminDb(env);
  if (!configured) {
    return createFallbackAdminState(env);
  }

  await ensureAdminSchema(configured.db);
  const [
    users,
    featureFlags,
    workspaces,
    runs,
    schemaCatalog,
    auditEvents
  ] = await Promise.all([
    listAdminUsers(configured.db),
    listFeatureFlags(configured.db),
    listWorkspaces(configured.db),
    listReviewQueue(configured.db),
    listSchemaCatalog(configured.db),
    listAuditEvents(configured.db)
  ]);

  return {
    phase: "phase-4",
    generatedAt: new Date().toISOString(),
    storage: {
      configured: true,
      binding: configured.binding,
      mode: "d1",
      message: `Persisted in Cloudflare D1 binding ${configured.binding}.`
    },
    auth: getAuthConfigState(env),
    bigQuery: getBigQueryConfigState(env),
    users,
    releaseTracks,
    featureFlags,
    reviewQueue: runs,
    workspaceAllowlist: workspaces,
    schemaCatalog,
    auditEvents
  };
}

export async function getSchemaPolicyCatalog(env: AdminStorageEnv): Promise<{
  tables: SchemaCatalogTable[];
  source: StorageMode;
  storageBinding: "ODAP_GATEWAY_DB" | "DB" | null;
}> {
  const configured = getAdminDb(env);
  if (!configured) {
    return {
      tables: createSeedSchemaCatalog(),
      source: "seed",
      storageBinding: null
    };
  }

  await ensureAdminSchema(configured.db);

  return {
    tables: await listSchemaCatalog(configured.db),
    source: "d1",
    storageBinding: configured.binding
  };
}

export async function getQueryRunDetail(
  env: AdminStorageEnv,
  id: string
): Promise<StoreMutationResult<QueryRunDetail>> {
  const configured = getAdminDb(env);
  if (!configured) {
    return storageNotConfigured();
  }

  await ensureAdminSchema(configured.db);
  const row = await configured.db
    .prepare(
      `SELECT
        id,
        workspace,
        actor_email,
        sql,
        status,
        mode,
        estimated_cost_usd,
        scanned_bytes,
        expected_runtime_ms,
        referenced_tables_json,
        checks_json,
        error_json,
        created_at,
        updated_at
      FROM query_runs
      WHERE id = ?`
    )
    .bind(id)
    .first<QueryRunRow>();

  if (!row) {
    return {
      ok: false,
      status: 404,
      code: "query_run_not_found",
      message: "Query run detail not found."
    };
  }

  return {
    ok: true,
    value: mapQueryRunRow(row)
  };
}

export async function upsertAuthenticatedUser(
  env: AdminStorageEnv,
  session: AuthSession
): Promise<UserUpsertResult> {
  const configured = getAdminDb(env);
  if (!configured) {
    return {
      persisted: false,
      storageBinding: null,
      role: null
    };
  }
  if (!configured.db.batch) {
    throw new Error("Transactional storage is required for login persistence");
  }

  await ensureAdminSchema(configured.db);
  const now = new Date().toISOString();
  const incomingRole = getSessionRole(session);
  const userId = createUserId(session.provider, session.providerId);
  const email = session.email.toLowerCase();
  const auditId = crypto.randomUUID();

  // Email can change, but it cannot link subjects or renew a revoked role.
  // Preserve the stored role in the write itself, including concurrent demotions.
  const results = await configured.db.batch([
    configured.db.prepare(
      `INSERT INTO users (
        id,
        provider,
        provider_id,
        email,
        name,
        avatar_url,
        role,
        last_login_at,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        email = excluded.email,
        name = excluded.name,
        avatar_url = excluded.avatar_url,
        last_login_at = excluded.last_login_at,
        updated_at = excluded.updated_at
      WHERE users.provider = excluded.provider
        AND users.provider_id = excluded.provider_id
      RETURNING role`
    )
    .bind(
      userId,
      session.provider,
      session.providerId,
      email,
      session.name,
      session.avatarUrl ?? null,
      incomingRole,
      now,
      now,
      now
    ),
    configured.db.prepare(
      `INSERT INTO audit_events (id, actor_email, action, target, metadata_json, created_at)
      SELECT ?, u.email, 'auth.login', u.provider,
        json_object('role', u.role, 'providerId', u.provider_id), ?
      FROM users AS u WHERE u.id = ? AND u.provider = ? AND u.provider_id = ?
        AND u.email = ? AND u.name = ? AND u.avatar_url IS ?
        AND u.last_login_at = ? AND u.updated_at = ?
        AND u.role IN ('admin', 'member') AND changes() = 1
      RETURNING id`
    ).bind(auditId, now, userId, session.provider, session.providerId,
      email, session.name, session.avatarUrl ?? null, now, now),
    // An ignored user or audit write must abort the entire login transaction,
    // including when an old audit already has the generated ID. Never delete it.
    configured.db.prepare(
      `SELECT CASE WHEN changes() <> 1 THEN abs(-9223372036854775808) ELSE 1 END AS confirmed`
    )
  ]);
  if (results.length !== 3 || results.some(result => result.success !== true || !Array.isArray(result.results))) {
    throw new Error("Login persistence transaction not confirmed");
  }
  const stored = results[0].results?.[0] as { role: AuthRole } | undefined;
  if (!stored || (stored.role !== "admin" && stored.role !== "member")) {
    throw new Error("Login identity could not be persisted");
  }
  if (results[0].results?.length !== 1 || results[1].results?.length !== 1 ||
      results[2].results?.[0]?.confirmed !== 1) {
    throw new Error("Login persistence audit not confirmed");
  }

  return {
    persisted: true,
    storageBinding: configured.binding,
    role: stored.role
  };
}

export async function updateAdminUserRole(
  env: AdminStorageEnv,
  id: string,
  role: AuthRole,
  actor: Pick<AuthSession, "provider" | "providerId" | "email">
): Promise<StoreMutationResult<AdminUserRecord>> {
  if (role !== "admin" && role !== "member") {
    return {
      ok: false,
      status: 400,
      code: "invalid_user_role",
      message: "User role must be admin or member."
    };
  }

  const configured = getAdminDb(env);
  if (!configured) {
    return storageNotConfigured();
  }
  if (!configured.db.batch) {
    return {
      ok: false,
      status: 503,
      code: "admin_role_transaction_unavailable",
      message: "Transactional storage is required for role updates."
    };
  }

  await ensureAdminSchema(configured.db);
  const existing = await getAdminUserById(configured.db, id);
  if (!existing) {
    return {
      ok: false,
      status: 404,
      code: "admin_user_not_found",
      message: "Admin user record was not found."
    };
  }

  const actorId = `${actor.provider}:${actor.providerId}`;
  if (id === actorId && role !== "admin") {
    return {
      ok: false,
      status: 409,
      code: "cannot_demote_self",
      message: "Use another administrator account to remove your own admin role."
    };
  }

  const updatedAt = new Date().toISOString();
  const auditId = crypto.randomUUID();
  // The tentative audit and guarded mutation are never visible separately.
  const results = await configured.db.batch([
    configured.db.prepare(
      `INSERT INTO audit_events (id, actor_email, action, target, metadata_json, created_at)
      SELECT ?, ?, 'user.role_updated', ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM users AS target, users AS actor
        WHERE target.id = ? AND target.role = ? AND target.email = ?
          AND actor.id = ? AND actor.provider = ? AND actor.provider_id = ?
          AND actor.role = 'admin' AND actor.email = ?
      ) OR EXISTS (SELECT 1 FROM audit_events WHERE id = ?)
      RETURNING id`
    ).bind(auditId, actor.email.toLowerCase(), existing.email,
      JSON.stringify({previousRole:existing.role,role}), updatedAt,
      id, existing.role, existing.email, actorId,
      actor.provider, actor.providerId, actor.email, auditId),
    configured.db.prepare(
      `UPDATE users
      SET role = ?, updated_at = ?
      WHERE id = ? AND role = ? AND email = ?
        AND changes() = 1
        AND EXISTS (SELECT 1 FROM audit_events WHERE id = ?)
        AND EXISTS (
          SELECT 1 FROM users AS actor
          WHERE actor.id = ? AND actor.provider = ? AND actor.provider_id = ?
            AND actor.role = 'admin' AND actor.email = ?
        )
      RETURNING id, provider, provider_id, email, name, avatar_url, role,
        last_login_at, created_at, updated_at`
    )
    .bind(
      role,
      updatedAt,
      id,
      existing.role,
      existing.email,
      auditId,
      actorId,
      actor.provider,
      actor.providerId,
      actor.email
    ),
    // Abort the batch if an audit exists without its role update. Deleting a
    // tentative event is unsafe when a colliding INSERT was itself ignored.
    configured.db.prepare(
      `SELECT CASE WHEN changes() = 0 AND EXISTS (SELECT 1 FROM audit_events WHERE id = ?)
        THEN abs(-9223372036854775808) ELSE 1 END AS confirmed`
    ).bind(auditId)
  ]);
  if (results.length !== 3 || results.some(result => result.success !== true || !Array.isArray(result.results))) {
    throw new Error("Role update transaction not confirmed");
  }
  const updated = results[1].results?.[0] as UserRow | undefined;

  if (!updated) {
    return {
      ok: false,
      status: 403,
      code: "admin_user_update_denied",
      message: "Administrator authority or the target user changed. Refresh before retrying."
    };
  }

  if (results[0].results?.length !== 1 || results[2].results?.[0]?.confirmed !== 1) {
    throw new Error("Role update audit not confirmed");
  }

  return {
    ok: true,
    value: mapUserRow(updated)
  };
}

export async function updateFeatureRollout(
  env: AdminStorageEnv,
  id: string,
  rollout: number,
  actor: Pick<AuthSession, "provider" | "providerId" | "email">
): Promise<StoreMutationResult<Phase2FeatureFlag>> {
  if (!Number.isInteger(rollout) || rollout < 0 || rollout > 100) {
    return {
      ok: false,
      status: 400,
      code: "invalid_rollout",
      message: "Rollout must be an integer between 0 and 100."
    };
  }

  const configured = getAdminDb(env);
  if (!configured) {
    return storageNotConfigured();
  }
  if (!configured.db.batch) {
    return {
      ok: false,
      status: 503,
      code: "feature_rollout_transaction_unavailable",
      message: "Transactional storage is required for feature rollout updates."
    };
  }

  await ensureAdminSchema(configured.db);
  const existing = await getFeatureFlag(configured.db, id);
  if (!existing) {
    return {
      ok: false,
      status: 404,
      code: "feature_flag_not_found",
      message: "Feature flag not found."
    };
  }

  const status = getFlagStatus(rollout);
  const updatedAt = new Date().toISOString();
  const auditId = crypto.randomUUID();
  const metadata = {
    environment: existing.environment,
    owner: existing.owner,
    previousRollout: existing.rollout,
    previousStatus: existing.status,
    rollout,
    status
  };
  const guard = `id = ? AND name = ? AND description = ? AND status = ?
    AND environment = ? AND rollout = ? AND owner = ? AND updated_at = ?
    AND EXISTS (
      SELECT 1 FROM users AS actor
      WHERE actor.id = ? AND actor.provider = ? AND actor.provider_id = ?
        AND actor.role = 'admin' AND actor.email = ?
    )`;
  const guardedValues: D1Value[] = [
    existing.id, existing.name, existing.description, existing.status,
    existing.environment, existing.rollout, existing.owner, existing.updatedAt,
    `${actor.provider}:${actor.providerId}`, actor.provider, actor.providerId, actor.email
  ];
  // Authorization and the inspected configuration must still match inside the
  // transaction; neither the tentative audit nor the change is visible alone.
  const results = await configured.db.batch([
    configured.db.prepare(
      `INSERT INTO audit_events (id, actor_email, action, target, metadata_json, created_at)
      SELECT ?, ?, 'feature_flag.rollout_updated', ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM feature_flags WHERE ${guard})
        OR EXISTS (SELECT 1 FROM audit_events WHERE id = ?)
      RETURNING id`
    ).bind(auditId, actor.email.toLowerCase(), id, JSON.stringify(metadata), updatedAt,
      ...guardedValues, auditId),
    configured.db.prepare(
      `UPDATE feature_flags
      SET rollout = ?, status = ?, updated_at = ?
      WHERE ${guard} AND changes() = 1 AND EXISTS (SELECT 1 FROM audit_events WHERE id = ?)
      RETURNING id, name, description, status, environment, rollout, owner, updated_at`
    ).bind(rollout, status, updatedAt, ...guardedValues, auditId),
    // SQLite integer overflow aborts the whole batch if an event exists but
    // the update was skipped. Never delete an event: even an ignored colliding
    // INSERT must not allow cleanup to remove historical audit evidence.
    configured.db.prepare(
      `SELECT CASE WHEN changes() = 0 AND EXISTS (SELECT 1 FROM audit_events WHERE id = ?)
        THEN abs(-9223372036854775808) ELSE 1 END AS confirmed`
    ).bind(auditId)
  ]);
  if (results.length !== 3 || results.some(result => result.success !== true || !Array.isArray(result.results))) {
    throw new Error("Feature rollout transaction not confirmed");
  }
  const updated = results[1].results?.[0] as FeatureFlagRow | undefined;
  if (!updated) {
    return {
      ok: false,
      status: 403,
      code: "feature_rollout_update_denied",
      message: "Administrator authority or the inspected feature flag changed. Refresh before retrying."
    };
  }
  if (results[0].results?.length !== 1 || results[2].results?.[0]?.confirmed !== 1) {
    throw new Error("Feature rollout audit not confirmed");
  }

  return {
    ok: true,
    value: mapFeatureFlagRow(updated)
  };
}

export async function updateRunReviewStatus(
  env: AdminStorageEnv,
  id: string,
  status: QueryRunStatus,
  actor: Pick<AuthSession, "provider" | "providerId" | "email">
): Promise<StoreMutationResult<ReviewQueueItem>> {
  if (status !== "approved" && status !== "blocked") {
    return {
      ok: false,
      status: 400,
      code: "invalid_run_status",
      message: "Run reviews can only be approved or blocked."
    };
  }

  const configured = getAdminDb(env);
  if (!configured) {
    return storageNotConfigured();
  }
  if (!configured.db.batch) {
    return {
      ok: false,
      status: 503,
      code: "run_review_transaction_unavailable",
      message: "Transactional storage is required for run review updates."
    };
  }

  await ensureAdminSchema(configured.db);
  const existing = await getRunReview(configured.db, id);
  if (!existing) {
    return {
      ok: false,
      status: 404,
      code: "run_review_not_found",
      message: "Run review not found."
    };
  }

  const run = await configured.db.prepare(
    `SELECT id, workspace, actor_email, sql, status, mode, estimated_cost_usd, scanned_bytes,
      expected_runtime_ms, referenced_tables_json, checks_json, error_json, created_at, updated_at
    FROM query_runs WHERE id = ?`
  ).bind(id).first<QueryRunRow>();
  if (!run || run.workspace !== existing.workspace || run.status !== existing.status ||
      run.estimated_cost_usd !== existing.estimated_cost_usd || run.scanned_bytes !== existing.scanned_bytes) {
    return {
      ok: false,
      status: 409,
      code: "run_review_inconsistent",
      message: "The review and query records do not match. Reconcile them before reviewing."
    };
  }

  const updatedAt = new Date().toISOString();
  const auditId = crypto.randomUUID();
  const action = status === "approved" ? "query.approved" : "query.blocked";
  const metadata = {workspace:existing.workspace,queryType:existing.query_type,
    previousStatus:existing.status,status,mode:run.mode,
    estimatedCostUsd:run.estimated_cost_usd,scannedBytes:run.scanned_bytes};
  const reviewGuard = `EXISTS (SELECT 1 FROM run_reviews WHERE id = ? AND workspace = ?
    AND query_type = ? AND status = ? AND estimated_cost_usd = ? AND scanned_bytes = ? AND submitted_at = ?)`;
  const queryGuard = `EXISTS (SELECT 1 FROM query_runs WHERE id = ? AND workspace = ?
    AND actor_email IS ? AND sql = ? AND status = ? AND mode = ? AND estimated_cost_usd = ?
    AND scanned_bytes = ? AND expected_runtime_ms = ? AND referenced_tables_json = ?
    AND checks_json = ? AND error_json IS ? AND created_at = ? AND updated_at = ?)`;
  const authorityGuard = `EXISTS (SELECT 1 FROM users AS actor WHERE actor.id = ?
    AND actor.provider = ? AND actor.provider_id = ? AND actor.role = 'admin' AND actor.email = ?)`;
  const guard = `${reviewGuard} AND ${queryGuard} AND ${authorityGuard}`;
  const reviewValues: D1Value[] = [existing.id,existing.workspace,existing.query_type,existing.status,
    existing.estimated_cost_usd,existing.scanned_bytes,existing.submitted_at];
  const queryValues = (queryStatus: QueryRunStatus, timestamp: string): D1Value[] => [
    run.id,run.workspace,run.actor_email,run.sql,queryStatus,run.mode,run.estimated_cost_usd,
    run.scanned_bytes,run.expected_runtime_ms,run.referenced_tables_json,run.checks_json,
    run.error_json,run.created_at,timestamp
  ];
  const authorityValues = [`${actor.provider}:${actor.providerId}`,actor.provider,actor.providerId,actor.email];
  const guardedValues = [...reviewValues,...queryValues(run.status,run.updated_at),...authorityValues];
  const assertion = `SELECT CASE WHEN changes() = 0 AND EXISTS (SELECT 1 FROM audit_events WHERE id = ?)
    THEN abs(-9223372036854775808) ELSE 1 END AS confirmed`;
  // Each status update must follow a real write. Assert after each one so an
  // ignored statement cannot leave a partial review or delete historical audit.
  const results = await configured.db.batch([
    configured.db.prepare(
      `INSERT INTO audit_events (id, actor_email, action, target, metadata_json, created_at)
      SELECT ?, ?, ?, ?, ?, ? WHERE (${guard}) OR EXISTS (SELECT 1 FROM audit_events WHERE id = ?)
      RETURNING id`
    ).bind(auditId,actor.email.toLowerCase(),action,id,JSON.stringify(metadata),updatedAt,...guardedValues,auditId),
    configured.db.prepare(
      `UPDATE query_runs SET status = ?, updated_at = ? WHERE id = ? AND ${guard}
        AND changes() = 1 AND EXISTS (SELECT 1 FROM audit_events WHERE id = ?) RETURNING id`
    ).bind(status,updatedAt,id,...guardedValues,auditId),
    configured.db.prepare(assertion).bind(auditId),
    configured.db.prepare(
      `UPDATE run_reviews SET status = ?, submitted_at = ? WHERE id = ? AND ${guard}
        AND changes() = 1 AND EXISTS (SELECT 1 FROM audit_events WHERE id = ?)
      RETURNING id, workspace, query_type, status, estimated_cost_usd, scanned_bytes, submitted_at`
    ).bind(status,updatedAt,id,...reviewValues,...queryValues(status,updatedAt),...authorityValues,auditId),
    configured.db.prepare(assertion).bind(auditId)
  ]);
  if (results.length !== 5 || results.some(result => result.success !== true || !Array.isArray(result.results))) {
    throw new Error("Run review transaction not confirmed");
  }
  const updated = results[3].results?.[0] as ReviewQueueRow | undefined;
  if (!updated) {
    return {
      ok: false,
      status: 403,
      code: "run_review_update_denied",
      message: "Administrator authority or the inspected run changed. Refresh before retrying."
    };
  }
  if (results[0].results?.length !== 1 || results[1].results?.length !== 1 ||
      results[2].results?.[0]?.confirmed !== 1 || results[4].results?.[0]?.confirmed !== 1) {
    throw new Error("Run review audit not confirmed");
  }

  return {
    ok: true,
    value: mapReviewQueueRow(updated)
  };
}

export async function updateSchemaFieldPolicy(
  env: AdminStorageEnv,
  id: string,
  input: {
    queryable?: boolean;
    pii?: boolean;
  },
  actor: Pick<AuthSession, "provider" | "providerId" | "email">
): Promise<StoreMutationResult<SchemaCatalogField>> {
  const patch = {
    queryable:
      typeof input.queryable === "boolean" ? input.queryable : undefined,
    pii: typeof input.pii === "boolean" ? input.pii : undefined
  };

  if (patch.queryable === undefined && patch.pii === undefined) {
    return {
      ok: false,
      status: 400,
      code: "invalid_schema_field_policy",
      message: "Provide a queryable or pii boolean policy update."
    };
  }

  const configured = getAdminDb(env);
  if (!configured) {
    return storageNotConfigured();
  }
  if (!configured.db.batch) {
    return {
      ok: false,
      status: 503,
      code: "schema_policy_transaction_unavailable",
      message: "Transactional storage is required for schema policy updates."
    };
  }

  await ensureAdminSchema(configured.db);
  const snapshot = await getSchemaFieldRow(configured.db, id);
  if (!snapshot) {
    return {
      ok: false,
      status: 404,
      code: "schema_field_not_found",
      message: "Schema field policy was not found."
    };
  }

  const existing = mapSchemaFieldRow(snapshot);
  const queryable = patch.queryable ?? existing.queryable;
  const pii = patch.pii ?? existing.pii;
  const updatedAt = new Date().toISOString();
  const auditId = crypto.randomUUID();
  const metadata = {
    tableId: snapshot.table_id,
    field: existing.name,
    previousQueryable: existing.queryable,
    previousPii: existing.pii,
    queryable,
    pii
  };
  // Bind the complete inspected field, not just its mutable policy flags.
  const guard = `id = ? AND table_id = ? AND field_name = ? AND field_type = ?
    AND mode = ? AND description = ? AND pii = ? AND queryable = ?
    AND used_in_examples = ? AND updated_at = ?
    AND EXISTS (
      SELECT 1 FROM users AS actor
      WHERE actor.id = ? AND actor.provider = ? AND actor.provider_id = ?
        AND actor.role = 'admin' AND actor.email = ?
    )`;
  const guardedValues: D1Value[] = [
    snapshot.id, snapshot.table_id, snapshot.field_name, snapshot.field_type,
    snapshot.mode, snapshot.description, snapshot.pii, snapshot.queryable,
    snapshot.used_in_examples, snapshot.updated_at,
    `${actor.provider}:${actor.providerId}`, actor.provider, actor.providerId, actor.email
  ];
  const results = await configured.db.batch([
    configured.db.prepare(
      `INSERT INTO audit_events (id, actor_email, action, target, metadata_json, created_at)
      SELECT ?, ?, 'schema_field.policy_updated', ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM schema_fields WHERE ${guard})
        OR EXISTS (SELECT 1 FROM audit_events WHERE id = ?)
      RETURNING id`
    ).bind(auditId, actor.email.toLowerCase(), id, JSON.stringify(metadata), updatedAt,
      ...guardedValues, auditId),
    configured.db.prepare(
      `UPDATE schema_fields
      SET queryable = ?, pii = ?, updated_at = ?
      WHERE ${guard} AND changes() = 1 AND EXISTS (SELECT 1 FROM audit_events WHERE id = ?)
      RETURNING id, table_id, field_name, field_type, mode, description,
        pii, queryable, used_in_examples, updated_at`
    ).bind(queryable ? 1 : 0, pii ? 1 : 0, updatedAt, ...guardedValues, auditId),
    // The overflow assertion rolls back an unmatched event without deleting
    // any audit row, including a historical ID whose INSERT was ignored.
    configured.db.prepare(
      `SELECT CASE WHEN changes() = 0 AND EXISTS (SELECT 1 FROM audit_events WHERE id = ?)
        THEN abs(-9223372036854775808) ELSE 1 END AS confirmed`
    ).bind(auditId)
  ]);
  if (results.length !== 3 || results.some(result => result.success !== true || !Array.isArray(result.results))) {
    throw new Error("Schema policy transaction not confirmed");
  }
  const updated = results[1].results?.[0] as SchemaFieldRow | undefined;
  if (!updated) {
    return {
      ok: false,
      status: 403,
      code: "schema_field_update_denied",
      message: "Administrator authority or the inspected field changed. Refresh before retrying."
    };
  }
  if (results[0].results?.length !== 1 || results[2].results?.[0]?.confirmed !== 1) {
    throw new Error("Schema policy audit not confirmed");
  }

  return {
    ok: true,
    value: mapSchemaFieldRow(updated)
  };
}

export async function importSchemaCatalog(
  env: AdminStorageEnv,
  input: {
    workspace: string;
    tables: SchemaImportTableInput[];
  },
  actor: Pick<AuthSession, "provider" | "providerId" | "email">
): Promise<StoreMutationResult<SchemaImportResult>> {
  const configured = getAdminDb(env);
  if (!configured) {
    return storageNotConfigured();
  }
  if (typeof configured.db.batch !== "function") {
    return {
      ok: false,
      status: 503,
      code: "schema_import_transaction_unavailable",
      message: "Transactional storage is required for schema imports."
    };
  }

  const workspace = normalizeWorkspace(input.workspace);
  const tables = input.tables.filter((table) => table.fields.length > 0);
  if (!tables.length) {
    return {
      ok: false,
      status: 400,
      code: "schema_import_empty",
      message: "No BigQuery schema tables were returned for import."
    };
  }

  await ensureAdminSchema(configured.db);
  const importedAt = new Date().toISOString();
  const importedFields = tables.reduce((count, table) => count + table.fields.length, 0);
  const requestedRestrictions = tables.flatMap(table => table.fields
    .filter(field => field.pii === true || field.queryable === false)
    .map(field => ({ table: table.name.trim(), field: field.name,
      ...(field.pii === true ? { pii: true } : {}),
      ...(field.queryable === false ? { queryable: false } : {}) })));
  const auditId = crypto.randomUUID();
  const authorityGuard = `EXISTS (SELECT 1 FROM users AS actor WHERE actor.id = ?
    AND actor.provider = ? AND actor.provider_id = ? AND actor.role = 'admin' AND actor.email = ?)`;
  const authorityValues = [`${actor.provider}:${actor.providerId}`, actor.provider, actor.providerId, actor.email];
  const writeGuard = `${authorityGuard} AND changes() = 1 AND EXISTS (SELECT 1 FROM audit_events WHERE id = ?)`;
  const assertWrite = () => configured.db.prepare(
    `SELECT CASE WHEN changes() <> 1 AND
      (EXISTS (SELECT 1 FROM audit_events WHERE id = ?) OR ${authorityGuard})
      THEN abs(-9223372036854775808) ELSE 1 END AS confirmed`
  ).bind(auditId, ...authorityValues);
  // Only a current canonical administrator may insert the admission audit.
  // Force historical ID collisions to fail even if authority has been revoked.
  const statements: D1PreparedStatement[] = [configured.db.prepare(
    `INSERT INTO audit_events (id, actor_email, action, target, metadata_json, created_at)
    SELECT ?, ?, 'schema_catalog.imported', ?, ?, ?
    WHERE ${authorityGuard} OR EXISTS (SELECT 1 FROM audit_events WHERE id = ?) RETURNING id`
  ).bind(auditId, actor.email.toLowerCase(), workspace,
    JSON.stringify({ importedTables: tables.length, importedFields,
      ...(requestedRestrictions.length ? { requestedRestrictions } : {}) }), importedAt,
    ...authorityValues, auditId), assertWrite()];
  const expectedWrites: Array<Record<string, D1Value>> = [{id: auditId}];

  for (const table of tables) {
    const tableName = table.name.trim();
    const tableId =
      (await getSchemaTableId(configured.db, workspace, tableName)) ??
      createImportedSchemaTableId(workspace, tableName);

    statements.push(configured.db
      .prepare(
        `INSERT INTO schema_tables (
          id,
          workspace,
          table_name,
          description,
          row_count,
          updated_at
        ) SELECT ?, ?, ?, ?, ?, ? WHERE ${writeGuard}
        ON CONFLICT(workspace, table_name) DO UPDATE SET
          description = excluded.description,
          row_count = excluded.row_count,
          updated_at = excluded.updated_at
        WHERE schema_tables.id = excluded.id
        RETURNING id`
      )
      .bind(
        tableId,
        workspace,
        tableName,
        table.description,
        table.rowCount,
        importedAt,
        ...authorityValues, auditId
      ), assertWrite());
    expectedWrites.push({id: tableId});

    for (const field of table.fields) {
      const fieldId = `${tableId}-${slugify(field.name)}`;
      const pii = field.pii ?? isSensitiveField(field.name);
      const queryable = field.queryable ?? !pii;

      statements.push(configured.db
        .prepare(
          `INSERT INTO schema_fields (
            id,
            table_id,
            field_name,
            field_type,
            mode,
            description,
            pii,
            queryable,
            used_in_examples,
            updated_at
          ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${writeGuard}
          ON CONFLICT(table_id, field_name) DO UPDATE SET
            field_type = excluded.field_type,
            mode = excluded.mode,
            description = excluded.description,
            pii = CASE WHEN ? = 1 THEN 1 ELSE schema_fields.pii END,
            queryable = CASE WHEN ? = 1 THEN 0 ELSE schema_fields.queryable END,
            used_in_examples = excluded.used_in_examples,
            updated_at = excluded.updated_at
          RETURNING id, table_id, field_name, pii, queryable`
        )
        .bind(
          fieldId,
          tableId,
          field.name,
          field.type,
          field.mode,
          field.description ?? getFieldDescription({
            name: field.name,
            type: normalizeSchemaFieldType(field.type)
          }),
          pii ? 1 : 0,
          queryable ? 1 : 0,
          field.usedInExamples ?? isExampleField(field.name) ? 1 : 0,
          importedAt,
          ...authorityValues, auditId,
          // Only explicit restrictions may change an existing field's policy.
          field.pii === true ? 1 : 0,
          field.queryable === false ? 1 : 0
        ), assertWrite());
      expectedWrites.push({ table_id: tableId, field_name: field.name,
        ...(field.pii === true ? { pii: 1 } : {}),
        ...(field.queryable === false ? { queryable: 0 } : {}) });
    }
  }

  // Assert every write inside the transaction: a later successful insert must
  // not conceal an ignored upsert or a table-ID change since the pre-read.
  const results = await configured.db.batch(statements);
  if (!Array.isArray(results) || results.length !== statements.length ||
      results.some((result, index) => result?.success !== true || !Array.isArray(result.results) ||
        result.results.length > 1 || (index % 2 === 1 && result.results.length !== 1))) {
    throw new Error("Schema import transaction not confirmed");
  }
  if (results[0].results?.length === 0) {
    if (results.some((result, index) => index % 2 === 0
      ? result.results?.length !== 0 : result.results?.[0]?.confirmed !== 1)) {
      throw new Error("Schema import transaction not confirmed");
    }
    return {
      ok: false,
      status: 403,
      code: "schema_import_denied",
      message: "Administrator authority changed. Refresh before retrying the import."
    };
  }
  if (results.some(result => result.results?.length !== 1)) {
    throw new Error("Schema import transaction not confirmed");
  }
  for (const [index, expected] of expectedWrites.entries()) {
    const row = results[index * 2].results![0];
    if (typeof row?.id !== "string" || !row.id ||
        !Object.entries(expected).every(([key, value]) => row[key] === value) ||
        results[index * 2 + 1].results?.[0]?.confirmed !== 1) {
      throw new Error("Schema import write not confirmed");
    }
  }

  return {
    ok: true,
    value: {
      workspace,
      importedTables: tables.length,
      importedFields,
      importedAt
    }
  };
}

export async function recordQueryDryRun(
  env: AdminStorageEnv,
  input: {
    workspace: string;
    queryType: string;
    actorEmail?: string;
    sql: string;
    preview: QueryRunPreview;
  }
): Promise<QueryRunRecordResult> {
  const id = createRunId();
  const configured = getAdminDb(env);
  if (!configured) {
    return {
      id,
      persisted: false,
      storageBinding: null
    };
  }
  if (typeof configured.db.batch !== "function") {
    throw new Error("Transactional storage is required for dry-run history");
  }

  await ensureAdminSchema(configured.db);
  const now = new Date().toISOString();
  const actorEmail = input.actorEmail?.toLowerCase() ?? null;
  const workspace = normalizeWorkspace(input.workspace);
  const queryType = input.queryType.trim() || "SQL dry run";
  const auditId = crypto.randomUUID();

  const results = await configured.db.batch([
    configured.db.prepare(
      `INSERT INTO query_runs (
        id,
        workspace,
        actor_email,
        sql,
        status,
        mode,
        estimated_cost_usd,
        scanned_bytes,
        expected_runtime_ms,
        referenced_tables_json,
        checks_json,
        error_json,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
    )
    .bind(
      id,
      workspace,
      actorEmail,
      input.sql,
      input.preview.status,
      input.preview.mode ?? "simulated",
      input.preview.estimatedCostUsd,
      input.preview.scannedBytes,
      input.preview.expectedRuntimeMs,
      JSON.stringify(input.preview.referencedTables),
      JSON.stringify(input.preview.checks),
      input.preview.error ? JSON.stringify(input.preview.error) : null,
      now,
      now
    ),
    configured.db.prepare(
      `INSERT INTO run_reviews (
        id,
        workspace,
        query_type,
        status,
        estimated_cost_usd,
        scanned_bytes,
        submitted_at
      ) SELECT ?, ?, ?, ?, ?, ?, ? WHERE changes() = 1 RETURNING id`
    )
    .bind(
      id,
      workspace,
      queryType,
      input.preview.status,
      input.preview.estimatedCostUsd,
      input.preview.scannedBytes,
      now
    ),
    configured.db.prepare(
      `INSERT INTO audit_events (id, actor_email, action, target, metadata_json, created_at)
      SELECT ?, ?, 'query.dry_run', ?, ?, ? WHERE changes() = 1 RETURNING id`
    ).bind(auditId, actorEmail ?? "anonymous@odap.local", id, JSON.stringify({
        workspace,
        queryType,
        status: input.preview.status,
        mode: input.preview.mode ?? "simulated",
        scannedBytes: input.preview.scannedBytes,
        estimatedCostUsd: input.preview.estimatedCostUsd
      }), now),
    // Each insert depends on the preceding write. A skipped insert must roll
    // back all history, even if a colliding historical ID already exists.
    configured.db.prepare(
      `SELECT CASE WHEN changes() <> 1 THEN abs(-9223372036854775808) ELSE 1 END AS confirmed`
    )
  ]);
  if (!Array.isArray(results) || results.length !== 4 ||
      results.some(result => result?.success !== true || !Array.isArray(result.results) || result.results.length !== 1) ||
      results[0].results?.[0]?.id !== id || results[1].results?.[0]?.id !== id ||
      results[2].results?.[0]?.id !== auditId || results[3].results?.[0]?.confirmed !== 1) {
    throw new Error("Dry-run history transaction not confirmed");
  }

  return {
    id,
    persisted: true,
    storageBinding: configured.binding
  };
}

export async function recordAuditEvent(
  env: AdminStorageEnv,
  event: {
    actorEmail: string;
    action: string;
    target: string;
    metadata?: Record<string, unknown>;
  }
) {
  const configured = getAdminDb(env);
  if (!configured) {
    return null;
  }

  await ensureAdminSchema(configured.db);
  const auditEvent = {
    id: crypto.randomUUID(),
    actorEmail: event.actorEmail.toLowerCase(),
    action: event.action,
    target: event.target,
    metadata: event.metadata ?? {},
    createdAt: new Date().toISOString()
  } satisfies AuditEvent;

  const persisted = await configured.db
    .prepare(
      `INSERT INTO audit_events (
        id,
        actor_email,
        action,
        target,
        metadata_json,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(
      auditEvent.id,
      auditEvent.actorEmail,
      auditEvent.action,
      auditEvent.target,
      JSON.stringify(auditEvent.metadata),
      auditEvent.createdAt
    )
    .run();
  if (persisted.success !== true) {
    throw new Error("Audit event persistence not confirmed");
  }

  return auditEvent;
}

export async function ensureAdminSchema(db: D1Database) {
  const statements = [
    `CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      avatar_url TEXT,
      role TEXT NOT NULL DEFAULT 'member',
      last_login_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS feature_flags (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL,
      environment TEXT NOT NULL,
      rollout INTEGER NOT NULL,
      owner TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS workspaces (
      workspace TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      plan TEXT NOT NULL,
      run_access TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS run_reviews (
      id TEXT PRIMARY KEY,
      workspace TEXT NOT NULL,
      query_type TEXT NOT NULL,
      status TEXT NOT NULL,
      estimated_cost_usd REAL NOT NULL,
      scanned_bytes INTEGER NOT NULL,
      submitted_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS query_runs (
      id TEXT PRIMARY KEY,
      workspace TEXT NOT NULL,
      actor_email TEXT,
      sql TEXT NOT NULL,
      status TEXT NOT NULL,
      mode TEXT NOT NULL,
      estimated_cost_usd REAL NOT NULL,
      scanned_bytes INTEGER NOT NULL,
      expected_runtime_ms INTEGER NOT NULL,
      referenced_tables_json TEXT NOT NULL,
      checks_json TEXT NOT NULL,
      error_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY,
      actor_email TEXT NOT NULL,
      action TEXT NOT NULL,
      target TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS schema_tables (
      id TEXT PRIMARY KEY,
      workspace TEXT NOT NULL,
      table_name TEXT NOT NULL,
      description TEXT NOT NULL,
      row_count INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(workspace, table_name)
    )`,
    `CREATE TABLE IF NOT EXISTS schema_fields (
      id TEXT PRIMARY KEY,
      table_id TEXT NOT NULL,
      field_name TEXT NOT NULL,
      field_type TEXT NOT NULL,
      mode TEXT NOT NULL,
      description TEXT NOT NULL,
      pii INTEGER NOT NULL,
      queryable INTEGER NOT NULL,
      used_in_examples INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(table_id, field_name)
    )`
  ];
  for (const query of statements) {
    const result = await db.prepare(query).run();
    if (result.success !== true) throw new Error("Admin table creation not confirmed");
  }
}

function createFallbackAdminState(env: AdminRuntimeEnv): AdminState {
  return {
    phase: "phase-4",
    generatedAt: new Date().toISOString(),
    storage: {
      configured: false,
      binding: null,
      mode: "seed",
      message:
        "Cloudflare D1 binding ODAP_GATEWAY_DB is not configured; showing seed data only."
    },
    auth: getAuthConfigState(env),
    bigQuery: getBigQueryConfigState(env),
    users: [],
    releaseTracks,
    featureFlags: phase2FeatureFlags,
    reviewQueue,
    workspaceAllowlist,
    schemaCatalog: createSeedSchemaCatalog(),
    auditEvents: fallbackAuditEvents
  };
}

function getAuthConfigState(env: AuthEnv): AuthConfigState {
  const adminEmails = parseAdminEmails(env.ADMIN_EMAILS);
  const googleConfigured = Boolean(
    env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
  );
  const githubConfigured = Boolean(
    env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
  );
  const cookieSecretConfigured = Boolean(env.AUTH_COOKIE_SECRET);
  const configured =
    cookieSecretConfigured &&
    adminEmails.length > 0 &&
    (googleConfigured || githubConfigured);

  return {
    configured,
    adminEmails,
    googleConfigured,
    githubConfigured,
    cookieSecretConfigured,
    message: configured
      ? "OAuth, signed session cookies, and administrator allowlist are configured."
      : "OAuth needs a cookie secret, at least one provider, and ADMIN_EMAILS before admin access is production-ready."
  };
}

function getBigQueryConfigState(env: BigQueryEnv): BigQueryConfigState {
  const configured = hasBigQueryCredentials(env);
  const transport = resolveDryRunTransport(env);
  const maxBytesBilled = parsePositiveNumber(env.BIGQUERY_MAX_BYTES_BILLED);

  return {
    configured,
    mode: transport.mode,
    projectId: env.BIGQUERY_PROJECT_ID ?? null,
    location: env.BIGQUERY_LOCATION ?? null,
    maxBytesBilled,
    message: transport.message
  };
}

function confirmedAdminRows<T>(response: D1Result<T>): T[] {
  if (response?.success !== true || !Array.isArray(response.results)) {
    throw new Error("Admin read not confirmed");
  }
  return response.results;
}

async function listFeatureFlags(db: D1Database) {
  const response = await db
    .prepare(
      `SELECT id, name, description, status, environment, rollout, owner, updated_at
      FROM feature_flags
      ORDER BY environment, name`
    )
    .all<FeatureFlagRow>();

  return confirmedAdminRows(response).map(mapFeatureFlagRow);
}

async function getFeatureFlag(db: D1Database, id: string) {
  const row = await db
    .prepare(
      `SELECT id, name, description, status, environment, rollout, owner, updated_at
      FROM feature_flags
      WHERE id = ?`
    )
    .bind(id)
    .first<FeatureFlagRow>();

  return row ? mapFeatureFlagRow(row) : null;
}

async function listWorkspaces(db: D1Database) {
  const response = await db
    .prepare(
      `SELECT workspace, owner, plan, run_access
      FROM workspaces
      ORDER BY workspace`
    )
    .all<WorkspaceRow>();

  return confirmedAdminRows(response).map((row) => ({
    workspace: row.workspace,
    owner: row.owner,
    plan: row.plan,
    runAccess: row.run_access
  }));
}

async function listAdminUsers(db: D1Database) {
  const response = await db
    .prepare(
      `SELECT
        id,
        provider,
        provider_id,
        email,
        name,
        avatar_url,
        role,
        last_login_at,
        created_at,
        updated_at
      FROM users
      ORDER BY role DESC, last_login_at DESC, email`
    )
    .all<UserRow>();

  return confirmedAdminRows(response).map(mapUserRow);
}

async function getAdminUserById(db: D1Database, id: string) {
  const row = await db
    .prepare(
      `SELECT
        id,
        provider,
        provider_id,
        email,
        name,
        avatar_url,
        role,
        last_login_at,
        created_at,
        updated_at
      FROM users
      WHERE id = ?`
    )
    .bind(id)
    .first<UserRow>();

  return row ? mapUserRow(row) : null;
}

async function listSchemaCatalog(db: D1Database) {
  const [tableResponse, fieldResponse] = await Promise.all([
    db
      .prepare(
        `SELECT id, workspace, table_name, description, row_count, updated_at
        FROM schema_tables
        ORDER BY workspace, table_name`
      )
      .all<SchemaTableRow>(),
    db
      .prepare(
        `SELECT
          id,
          table_id,
          field_name,
          field_type,
          mode,
          description,
          pii,
          queryable,
          used_in_examples,
          updated_at
        FROM schema_fields
        ORDER BY table_id, used_in_examples DESC, field_name`
      )
      .all<SchemaFieldRow>()
  ]);

  const tables = confirmedAdminRows(tableResponse);
  const fieldRows = confirmedAdminRows(fieldResponse);
  const fieldsByTable = new Map<string, SchemaCatalogField[]>();
  for (const row of fieldRows) {
    const fields = fieldsByTable.get(row.table_id) ?? [];
    fields.push(mapSchemaFieldRow(row));
    fieldsByTable.set(row.table_id, fields);
  }

  return tables.map((row) => ({
    id: row.id,
    workspace: row.workspace,
    name: row.table_name,
    description: row.description,
    rowCount: row.row_count,
    updatedAt: row.updated_at,
    fields: fieldsByTable.get(row.id) ?? []
  }));
}

async function getSchemaFieldRow(db: D1Database, id: string) {
  return db
    .prepare(
      `SELECT
        id,
        table_id,
        field_name,
        field_type,
        mode,
        description,
        pii,
        queryable,
        used_in_examples,
        updated_at
      FROM schema_fields
      WHERE id = ?`
    )
    .bind(id)
    .first<SchemaFieldRow>();
}

async function getSchemaTableId(
  db: D1Database,
  workspace: string,
  tableName: string
) {
  const row = await db
    .prepare(
      `SELECT id
      FROM schema_tables
      WHERE workspace = ? AND table_name = ?`
    )
    .bind(workspace, tableName)
    .first<{ id: string }>();

  return row?.id ?? null;
}

async function listReviewQueue(db: D1Database) {
  const response = await db
    .prepare(
      `SELECT id, workspace, query_type, status, estimated_cost_usd, scanned_bytes, submitted_at
      FROM run_reviews
      ORDER BY id DESC`
    )
    .all<ReviewQueueRow>();

  return confirmedAdminRows(response).map((row) => ({
    id: row.id,
    workspace: row.workspace,
    queryType: row.query_type,
    status: row.status,
    estimatedCostUsd: row.estimated_cost_usd,
    scannedBytes: row.scanned_bytes,
    submittedAt: row.submitted_at
  }));
}

async function getRunReview(db: D1Database, id: string) {
  return db
    .prepare(
      `SELECT id, workspace, query_type, status, estimated_cost_usd, scanned_bytes, submitted_at
      FROM run_reviews
      WHERE id = ?`
    )
    .bind(id)
    .first<ReviewQueueRow>();
}

function mapReviewQueueRow(row: ReviewQueueRow): ReviewQueueItem {
  return {
    id: row.id,
    workspace: row.workspace,
    queryType: row.query_type,
    status: row.status,
    estimatedCostUsd: row.estimated_cost_usd,
    scannedBytes: row.scanned_bytes,
    submittedAt: row.submitted_at
  };
}

function mapQueryRunRow(row: QueryRunRow): QueryRunDetail {
  return {
    id: row.id,
    workspace: row.workspace,
    actorEmail: row.actor_email,
    sql: row.sql,
    status: row.status,
    mode: row.mode,
    estimatedCostUsd: row.estimated_cost_usd,
    scannedBytes: row.scanned_bytes,
    expectedRuntimeMs: row.expected_runtime_ms,
    referencedTables: parseJsonArray<string>(row.referenced_tables_json),
    checks: parseJsonArray<QueryRunPreview["checks"][number]>(row.checks_json),
    error: parseJsonRecord(row.error_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function parseJsonArray<T>(value: string): T[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function parseJsonRecord(value: string | null) {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed)
      ? (parsed as QueryRunPreview["error"])
      : null;
  } catch {
    return null;
  }
}

async function listAuditEvents(db: D1Database) {
  const response = await db
    .prepare(
      `SELECT id, actor_email, action, target, metadata_json, created_at
      FROM audit_events
      ORDER BY created_at DESC
      LIMIT 20`
    )
    .all<AuditEventRow>();

  return confirmedAdminRows(response).map((row) => ({
    id: row.id,
    actorEmail: row.actor_email,
    action: row.action,
    target: row.target,
    metadata: parseMetadata(row.metadata_json),
    createdAt: row.created_at
  }));
}

function mapSchemaFieldRow(row: SchemaFieldRow): SchemaCatalogField {
  return {
    id: row.id,
    name: row.field_name,
    type: row.field_type,
    mode: row.mode,
    description: row.description,
    pii: row.pii === 1,
    queryable: row.queryable === 1,
    usedInExamples: row.used_in_examples === 1,
    updatedAt: row.updated_at
  };
}

function mapFeatureFlagRow(row: FeatureFlagRow): Phase2FeatureFlag {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status,
    environment: row.environment,
    rollout: row.rollout,
    owner: row.owner,
    updatedAt: row.updated_at
  };
}

function mapUserRow(row: UserRow): AdminUserRecord {
  return {
    id: row.id,
    provider: row.provider,
    providerId: row.provider_id,
    email: row.email,
    name: row.name,
    avatarUrl: row.avatar_url,
    role: row.role === "admin" ? "admin" : "member",
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function getFlagStatus(rollout: number): FeatureFlagStatus {
  if (rollout === 0) {
    return "paused";
  }

  if (rollout < 100) {
    return "guarded";
  }

  return "enabled";
}

function createSeedSchemaCatalog(): SchemaCatalogTable[] {
  return schemaTables.map((table) => createSeedSchemaTable(table));
}

function createSeedSchemaTable(table: SchemaTable): SchemaCatalogTable {
  const id = createSchemaTableId(table.name);
  const workspace = table.name.split(".")[0] ?? "demo";
  const updatedAt = "2026-06-22T00:00:00.000Z";

  return {
    id,
    workspace,
    name: table.name,
    description: getTableDescription(table.name),
    rowCount: getSeedRowCount(table.name),
    updatedAt,
    fields: table.fields.map((field) =>
      createSeedSchemaField(id, field, updatedAt)
    )
  };
}

function createSeedSchemaField(
  tableId: string,
  field: SchemaField,
  updatedAt: string
): SchemaCatalogField {
  const pii = isSensitiveField(field.name);

  return {
    id: `${tableId}-${slugify(field.name)}`,
    name: field.name,
    type: field.type,
    mode: field.key ? "REQUIRED" : "NULLABLE",
    description: getFieldDescription(field),
    pii,
    queryable: !pii,
    usedInExamples: isExampleField(field.name),
    updatedAt
  };
}

function createSchemaTableId(tableName: string) {
  return `table-${slugify(tableName)}`;
}

function createImportedSchemaTableId(workspace: string, tableName: string) {
  const firstTablePart = tableName.split(".")[0]?.toLowerCase();

  if (firstTablePart === workspace) {
    return createSchemaTableId(tableName);
  }

  return createSchemaTableId(`${workspace}.${tableName}`);
}

function slugify(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function getTableDescription(tableName: string) {
  if (tableName === "demo.orders") {
    return "Order facts for revenue, channel, and status analysis.";
  }

  if (tableName === "demo.customers") {
    return "Customer profile dimensions used for cohort and plan reporting.";
  }

  if (tableName === "demo.events") {
    return "Product event stream for funnel, session, and behavior queries.";
  }

  return "Schema table managed by the Open Data Agent Platform admin catalog.";
}

function getSeedRowCount(tableName: string) {
  const rowCounts: Record<string, number> = {
    "demo.orders": 8420000,
    "demo.customers": 1240000,
    "demo.events": 178000000
  };

  return rowCounts[tableName] ?? 0;
}

function getFieldDescription(field: SchemaField) {
  if (field.key) {
    return "Primary join key for this table.";
  }

  const label = field.name.replace(/_/g, " ");
  return `${label.charAt(0).toUpperCase()}${label.slice(1)} column.`;
}

function normalizeSchemaFieldType(value: string): SchemaField["type"] {
  if (
    value === "INT64" ||
    value === "DATE" ||
    value === "STRING" ||
    value === "FLOAT64" ||
    value === "TIMESTAMP"
  ) {
    return value;
  }

  return "STRING";
}

function isSensitiveField(fieldName: string) {
  return /\b(email|phone|address|ssn|ip|user_id|customer_id|session_id)\b/i.test(
    fieldName
  );
}

function isExampleField(fieldName: string) {
  return exampleSchemaFields.has(fieldName);
}

function storageNotConfigured(): StoreMutationResult<never> {
  return {
    ok: false,
    status: 409,
    code: "storage_not_configured",
    message: "Cloudflare D1 binding ODAP_GATEWAY_DB is required for this action."
  };
}

function createUserId(provider: AuthProvider, providerId: string) {
  return `${provider}:${providerId}`;
}

function createRunId() {
  const timestamp = new Date()
    .toISOString()
    .replace(/\D/g, "")
    .slice(0, 14);

  return `run-${timestamp}-${crypto.randomUUID().slice(0, 8)}`;
}

function normalizeWorkspace(value: string) {
  const trimmed = value.trim().toLowerCase();
  return trimmed || "demo";
}

function parseMetadata(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parsePositiveNumber(value: string | undefined) {
  if (!value) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function getRoleLabel(role: AuthRole) {
  return role === "admin" ? "Administrator" : "Member";
}
