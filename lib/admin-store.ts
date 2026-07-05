import type { AuthEnv, AuthProvider, AuthSession } from "./auth";
import { getSessionRole, parseAdminEmails, type AuthRole } from "./auth";
import {
  hasBigQueryCredentials,
  type BigQueryEnv
} from "./bigquery";
import {
  schemaTables,
  type SchemaField,
  type SchemaTable
} from "./content";
import type { D1Database } from "./d1";
import {
  estimateDryRun,
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
  mode: "live" | "simulated";
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
      status: 400 | 404 | 409 | 500;
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
    actorEmail: "system@odap-gateway.example",
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

  await ensureAdminSchema(configured.db);
  const now = new Date().toISOString();
  const existing = await getAdminUserByEmail(
    configured.db,
    session.email.toLowerCase()
  );
  const incomingRole = getSessionRole(session);
  const role = incomingRole === "admin" ? "admin" : existing?.role ?? "member";

  await configured.db
    .prepare(
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
      ON CONFLICT(email) DO UPDATE SET
        provider = excluded.provider,
        provider_id = excluded.provider_id,
        name = excluded.name,
        avatar_url = excluded.avatar_url,
        role = excluded.role,
        last_login_at = excluded.last_login_at,
        updated_at = excluded.updated_at`
    )
    .bind(
      createUserId(session.provider, session.providerId),
      session.provider,
      session.providerId,
      session.email.toLowerCase(),
      session.name,
      session.avatarUrl ?? null,
      role,
      now,
      now,
      now
    )
    .run();

  await recordAuditEvent(env, {
    actorEmail: session.email,
    action: "auth.login",
    target: session.provider,
    metadata: {
      role,
      providerId: session.providerId
    }
  });

  return {
    persisted: true,
    storageBinding: configured.binding,
    role
  };
}

export async function updateAdminUserRole(
  env: AdminStorageEnv,
  id: string,
  role: AuthRole,
  actorEmail: string
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

  if (
    existing.email.toLowerCase() === actorEmail.toLowerCase() &&
    role !== "admin"
  ) {
    return {
      ok: false,
      status: 409,
      code: "cannot_demote_self",
      message: "Use another administrator account to remove your own admin role."
    };
  }

  const updatedAt = new Date().toISOString();
  await configured.db
    .prepare(
      `UPDATE users
      SET role = ?, updated_at = ?
      WHERE id = ?`
    )
    .bind(role, updatedAt, id)
    .run();

  await recordAuditEvent(env, {
    actorEmail,
    action: "user.role_updated",
    target: existing.email,
    metadata: {
      previousRole: existing.role,
      role
    }
  });

  const updated = await getAdminUserById(configured.db, id);
  return {
    ok: true,
    value: updated ?? {
      ...existing,
      role,
      updatedAt
    }
  };
}

export async function updateFeatureRollout(
  env: AdminStorageEnv,
  id: string,
  rollout: number,
  actorEmail: string
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

  const updatedFlag = {
    ...existing,
    rollout,
    status: getFlagStatus(rollout),
    updatedAt: new Date().toISOString()
  } satisfies Phase2FeatureFlag;

  await configured.db
    .prepare(
      `UPDATE feature_flags
      SET rollout = ?, status = ?, updated_at = ?
      WHERE id = ?`
    )
    .bind(
      updatedFlag.rollout,
      updatedFlag.status,
      updatedFlag.updatedAt,
      updatedFlag.id
    )
    .run();

  await recordAuditEvent(env, {
    actorEmail,
    action: "feature_flag.rollout_updated",
    target: id,
    metadata: {
      rollout,
      status: updatedFlag.status
    }
  });

  return {
    ok: true,
    value: updatedFlag
  };
}

export async function queueRollback(
  env: AdminStorageEnv,
  actorEmail: string
): Promise<StoreMutationResult<{ queuedAt: string; target: string }>> {
  const configured = getAdminDb(env);
  if (!configured) {
    return storageNotConfigured();
  }

  const queuedAt = new Date().toISOString();
  await recordAuditEvent(env, {
    actorEmail,
    action: "rollback.queued",
    target: "prod-20260620",
    metadata: {
      rollbackTarget: "prod-20260620",
      queuedAt
    }
  });

  return {
    ok: true,
    value: {
      queuedAt,
      target: "prod-20260620"
    }
  };
}

export async function updateRunReviewStatus(
  env: AdminStorageEnv,
  id: string,
  status: QueryRunStatus,
  actorEmail: string
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

  const updated = {
    ...existing,
    status,
    submittedAt: new Date().toISOString()
  } satisfies ReviewQueueItem;

  await configured.db
    .prepare(
      `UPDATE run_reviews
      SET status = ?, submitted_at = ?
      WHERE id = ?`
    )
    .bind(updated.status, updated.submittedAt, updated.id)
    .run();

  await configured.db
    .prepare(
      `UPDATE query_runs
      SET status = ?, updated_at = ?
      WHERE id = ?`
    )
    .bind(updated.status, updated.submittedAt, updated.id)
    .run();

  await recordAuditEvent(env, {
    actorEmail,
    action:
      status === "approved" ? "query.approved" : "query.blocked",
    target: id,
    metadata: {
      workspace: updated.workspace,
      queryType: updated.queryType,
      status
    }
  });

  return {
    ok: true,
    value: updated
  };
}

export async function updateSchemaFieldPolicy(
  env: AdminStorageEnv,
  id: string,
  input: {
    queryable?: boolean;
    pii?: boolean;
  },
  actorEmail: string
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

  await ensureAdminSchema(configured.db);
  const existing = await getSchemaField(configured.db, id);
  if (!existing) {
    return {
      ok: false,
      status: 404,
      code: "schema_field_not_found",
      message: "Schema field policy was not found."
    };
  }

  const updated = {
    ...existing,
    queryable: patch.queryable ?? existing.queryable,
    pii: patch.pii ?? existing.pii,
    updatedAt: new Date().toISOString()
  } satisfies SchemaCatalogField;

  await configured.db
    .prepare(
      `UPDATE schema_fields
      SET queryable = ?, pii = ?, updated_at = ?
      WHERE id = ?`
    )
    .bind(
      updated.queryable ? 1 : 0,
      updated.pii ? 1 : 0,
      updated.updatedAt,
      updated.id
    )
    .run();

  await recordAuditEvent(env, {
    actorEmail,
    action: "schema_field.policy_updated",
    target: id,
    metadata: {
      field: existing.name,
      queryable: updated.queryable,
      pii: updated.pii
    }
  });

  return {
    ok: true,
    value: updated
  };
}

export async function importSchemaCatalog(
  env: AdminStorageEnv,
  input: {
    workspace: string;
    tables: SchemaImportTableInput[];
  },
  actorEmail: string
): Promise<StoreMutationResult<SchemaImportResult>> {
  const configured = getAdminDb(env);
  if (!configured) {
    return storageNotConfigured();
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
  let importedFields = 0;

  for (const table of tables) {
    const tableName = table.name.trim();
    const tableId =
      (await getSchemaTableId(configured.db, workspace, tableName)) ??
      createImportedSchemaTableId(workspace, tableName);

    await configured.db
      .prepare(
        `INSERT INTO schema_tables (
          id,
          workspace,
          table_name,
          description,
          row_count,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(workspace, table_name) DO UPDATE SET
          description = excluded.description,
          row_count = excluded.row_count,
          updated_at = excluded.updated_at`
      )
      .bind(
        tableId,
        workspace,
        tableName,
        table.description,
        table.rowCount,
        importedAt
      )
      .run();

    for (const field of table.fields) {
      const fieldId = `${tableId}-${slugify(field.name)}`;
      const pii = field.pii ?? isSensitiveField(field.name);
      const queryable = field.queryable ?? !pii;

      await configured.db
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
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(table_id, field_name) DO UPDATE SET
            field_type = excluded.field_type,
            mode = excluded.mode,
            description = excluded.description,
            used_in_examples = excluded.used_in_examples,
            updated_at = excluded.updated_at`
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
          importedAt
        )
        .run();
      importedFields += 1;
    }
  }

  await recordAuditEvent(env, {
    actorEmail,
    action: "schema_catalog.imported",
    target: workspace,
    metadata: {
      importedTables: tables.length,
      importedFields
    }
  });

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

  await ensureAdminSchema(configured.db);
  const now = new Date().toISOString();
  const actorEmail = input.actorEmail?.toLowerCase() ?? null;
  const workspace = normalizeWorkspace(input.workspace);
  const queryType = input.queryType.trim() || "SQL dry run";

  await configured.db
    .prepare(
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
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
    )
    .run();

  await configured.db
    .prepare(
      `INSERT OR REPLACE INTO run_reviews (
        id,
        workspace,
        query_type,
        status,
        estimated_cost_usd,
        scanned_bytes,
        submitted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      workspace,
      queryType,
      input.preview.status,
      input.preview.estimatedCostUsd,
      input.preview.scannedBytes,
      now
    )
    .run();

  await recordAuditEvent(env, {
    actorEmail: actorEmail ?? "anonymous@odap-gateway.example",
    action: "query.dry_run",
    target: id,
    metadata: {
      workspace,
      queryType,
      status: input.preview.status,
      mode: input.preview.mode ?? "simulated",
      scannedBytes: input.preview.scannedBytes,
      estimatedCostUsd: input.preview.estimatedCostUsd
    }
  });

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

  await configured.db
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

  return auditEvent;
}

export async function ensureAdminSchema(db: D1Database) {
  await db
    .prepare(
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
      )`
    )
    .run();

  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS feature_flags (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL,
        environment TEXT NOT NULL,
        rollout INTEGER NOT NULL,
        owner TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`
    )
    .run();

  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS workspaces (
        workspace TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        plan TEXT NOT NULL,
        run_access TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`
    )
    .run();

  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS run_reviews (
        id TEXT PRIMARY KEY,
        workspace TEXT NOT NULL,
        query_type TEXT NOT NULL,
        status TEXT NOT NULL,
        estimated_cost_usd REAL NOT NULL,
        scanned_bytes INTEGER NOT NULL,
        submitted_at TEXT NOT NULL
      )`
    )
    .run();

  await db
    .prepare(
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
      )`
    )
    .run();

  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY,
        actor_email TEXT NOT NULL,
        action TEXT NOT NULL,
        target TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`
    )
    .run();

  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS schema_tables (
        id TEXT PRIMARY KEY,
        workspace TEXT NOT NULL,
        table_name TEXT NOT NULL,
        description TEXT NOT NULL,
        row_count INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(workspace, table_name)
      )`
    )
    .run();

  await db
    .prepare(
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
    )
    .run();

  await seedAdminDefaults(db);
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
  const maxBytesBilled = parsePositiveNumber(env.BIGQUERY_MAX_BYTES_BILLED);

  return {
    configured,
    mode:
      configured && env.BIGQUERY_DRY_RUN_MODE !== "simulated"
        ? "live"
        : "simulated",
    projectId: env.BIGQUERY_PROJECT_ID ?? null,
    location: env.BIGQUERY_LOCATION ?? null,
    maxBytesBilled,
    message: configured
      ? "BigQuery service account credentials are configured for live dry-run."
      : "BigQuery credentials are missing; dry-run uses simulated estimates."
  };
}

async function seedAdminDefaults(db: D1Database) {
  await Promise.all(
    phase2FeatureFlags.map((flag) =>
      db
        .prepare(
          `INSERT OR IGNORE INTO feature_flags (
            id,
            name,
            description,
            status,
            environment,
            rollout,
            owner,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          flag.id,
          flag.name,
          flag.description,
          flag.status,
          flag.environment,
          flag.rollout,
          flag.owner,
          flag.updatedAt
        )
        .run()
    )
  );

  await Promise.all(
    workspaceAllowlist.map((workspace) =>
      db
        .prepare(
          `INSERT OR IGNORE INTO workspaces (
            workspace,
            owner,
            plan,
            run_access,
            updated_at
          ) VALUES (?, ?, ?, ?, ?)`
        )
        .bind(
          workspace.workspace,
          workspace.owner,
          workspace.plan,
          workspace.runAccess,
          "2026-06-20T00:00:00.000Z"
        )
        .run()
    )
  );

  const seedCatalog = createSeedSchemaCatalog();
  await Promise.all(
    seedCatalog.map((table) =>
      db
        .prepare(
          `INSERT OR IGNORE INTO schema_tables (
            id,
            workspace,
            table_name,
            description,
            row_count,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?)`
        )
        .bind(
          table.id,
          table.workspace,
          table.name,
          table.description,
          table.rowCount,
          table.updatedAt
        )
        .run()
    )
  );

  await Promise.all(
    seedCatalog.flatMap((table) =>
      table.fields.map((field) =>
        db
          .prepare(
            `INSERT OR IGNORE INTO schema_fields (
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
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            field.id,
            table.id,
            field.name,
            field.type,
            field.mode,
            field.description,
            field.pii ? 1 : 0,
            field.queryable ? 1 : 0,
            field.usedInExamples ? 1 : 0,
            field.updatedAt
          )
          .run()
      )
    )
  );

  await Promise.all(
    reviewQueue.map((item) =>
      db
        .prepare(
          `INSERT OR IGNORE INTO run_reviews (
            id,
            workspace,
            query_type,
            status,
            estimated_cost_usd,
            scanned_bytes,
            submitted_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          item.id,
          item.workspace,
          item.queryType,
          item.status,
          item.estimatedCostUsd,
          item.scannedBytes,
          item.submittedAt
        )
        .run()
    )
  );

  await Promise.all(
    reviewQueue.map((item) => {
      const sql = getSeedRunSql(item.id);
      const preview = estimateDryRun(sql);

      return db
        .prepare(
          `INSERT OR IGNORE INTO query_runs (
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
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          item.id,
          item.workspace,
          "seed@odap-gateway.example",
          sql,
          item.status,
          "simulated",
          item.estimatedCostUsd,
          item.scannedBytes,
          preview.expectedRuntimeMs,
          JSON.stringify(preview.referencedTables),
          JSON.stringify(preview.checks),
          item.status === "blocked"
            ? JSON.stringify({
                code: "seed_blocked",
                message: "Seed query is blocked by the safety policy."
              })
            : null,
          item.submittedAt,
          item.submittedAt
        )
        .run();
    })
  );
}

async function listFeatureFlags(db: D1Database) {
  const response = await db
    .prepare(
      `SELECT id, name, description, status, environment, rollout, owner, updated_at
      FROM feature_flags
      ORDER BY environment, name`
    )
    .all<FeatureFlagRow>();

  return (response.results ?? []).map(mapFeatureFlagRow);
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

  return (response.results ?? []).map((row) => ({
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

  return (response.results ?? []).map(mapUserRow);
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

async function getAdminUserByEmail(db: D1Database, email: string) {
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
      WHERE email = ?`
    )
    .bind(email.toLowerCase())
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

  const fieldsByTable = new Map<string, SchemaCatalogField[]>();
  for (const row of fieldResponse.results ?? []) {
    const fields = fieldsByTable.get(row.table_id) ?? [];
    fields.push(mapSchemaFieldRow(row));
    fieldsByTable.set(row.table_id, fields);
  }

  return (tableResponse.results ?? []).map((row) => ({
    id: row.id,
    workspace: row.workspace,
    name: row.table_name,
    description: row.description,
    rowCount: row.row_count,
    updatedAt: row.updated_at,
    fields: fieldsByTable.get(row.id) ?? []
  }));
}

async function getSchemaField(db: D1Database, id: string) {
  const row = await db
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

  return row ? mapSchemaFieldRow(row) : null;
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

  return (response.results ?? []).map((row) => ({
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
  const row = await db
    .prepare(
      `SELECT id, workspace, query_type, status, estimated_cost_usd, scanned_bytes, submitted_at
      FROM run_reviews
      WHERE id = ?`
    )
    .bind(id)
    .first<ReviewQueueRow>();

  return row
    ? {
        id: row.id,
        workspace: row.workspace,
        queryType: row.query_type,
        status: row.status,
        estimatedCostUsd: row.estimated_cost_usd,
        scannedBytes: row.scanned_bytes,
        submittedAt: row.submitted_at
      }
    : null;
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

function getSeedRunSql(id: string) {
  if (id === "run-1026") {
    return "SELECT campaign_id, session_id FROM `marketing.sessions`;";
  }

  if (id === "run-1025") {
    return "DROP TABLE `sandbox.tmp_orders`;";
  }

  return `SELECT
  DATE_TRUNC(order_date, WEEK) AS week_start,
  acquisition_channel,
  SUM(revenue) AS weekly_revenue,
  COUNT(*) AS order_count
FROM \`analytics.orders\`
WHERE order_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 8 WEEK)
GROUP BY week_start, acquisition_channel
ORDER BY week_start DESC;`;
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

  return (response.results ?? []).map((row) => ({
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
  const workspace = table.name.split(".")[0] ?? "analytics";
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
  if (tableName === "analytics.orders") {
    return "Order facts for revenue, channel, and status analysis.";
  }

  if (tableName === "analytics.customers") {
    return "Customer profile dimensions used for cohort and plan reporting.";
  }

  if (tableName === "analytics.events") {
    return "Product event stream for funnel, session, and behavior queries.";
  }

  return "Schema table managed by the Open Data Agent Platform admin catalog.";
}

function getSeedRowCount(tableName: string) {
  const rowCounts: Record<string, number> = {
    "analytics.orders": 8420000,
    "analytics.customers": 1240000,
    "analytics.events": 178000000
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
  return trimmed || "analytics";
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
