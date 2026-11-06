import {
  runBigQueryQuery,
  type BigQueryEnv,
  type BigQueryQueryRow
} from "./bigquery";
import {
  getAdminDb,
  importSchemaCatalog,
  type AdminStorageEnv,
  type SchemaImportResult,
  type SchemaImportTableInput,
  type StoreMutationResult
} from "./admin-store";
import type { AuthSession } from "./auth";

export type BigQuerySchemaImportInput = {
  workspace: string;
  dataset: string;
  projectId?: string;
  tablePrefix?: string;
  tableLimit?: number;
};

export type BigQuerySchemaImportResult = SchemaImportResult & {
  projectId: string;
  dataset: string;
  tablePrefix: string | null;
};

type InformationSchemaRow = {
  table_catalog: string;
  table_schema: string;
  table_name: string;
  table_type: string;
  column_name: string;
  data_type: string;
  is_nullable: string;
  ordinal_position: number | null;
  policy_tags: string | null;
};

const DEFAULT_TABLE_LIMIT = 50;
const MAX_TABLE_LIMIT = 100;
const IMPORT_TABLE_TYPES = ["BASE TABLE", "CLONE", "EXTERNAL", "MATERIALIZED VIEW", "SNAPSHOT", "VIEW"];
const METADATA_FIELDS = ["table_catalog", "table_schema", "table_name", "table_type", "column_name",
  "data_type", "is_nullable", "ordinal_position", "policy_tags"];
type SchemaImportSource = Required<Omit<BigQuerySchemaImportInput, "workspace">>;

export async function importBigQuerySchemaCatalog(
  env: AdminStorageEnv & BigQueryEnv,
  input: BigQuerySchemaImportInput,
  actor: Pick<AuthSession, "provider" | "providerId" | "email">
): Promise<StoreMutationResult<BigQuerySchemaImportResult>> {
  const configured = getAdminDb(env);
  if (!configured) {
    return {
      ok: false,
      status: 409,
      code: "storage_not_configured",
      message: "Cloudflare D1 binding ODAP_GATEWAY_DB is required for this action."
    };
  }

  const normalized = normalizeImportInput(input, env);
  if (!normalized.ok) {
    return normalized;
  }

  // Non-demo requests still reach the legacy provider's mode refusal first.
  if (env.GATEWAY_MODE === "demo" && typeof configured.db.batch !== "function") {
    return {
      ok: false,
      status: 503,
      code: "schema_import_transaction_unavailable",
      message: "Transactional storage is required for schema imports."
    };
  }

  const query = await runBigQueryQuery(
    buildInformationSchemaQuery(normalized.value),
    env
  );
  if (!query.ok) {
    return {
      ok: false,
      status: ["legacy_query_disabled", "bigquery_not_configured"].includes(query.code) ? 409 : 500,
      code: query.code,
      message: query.message
    };
  }

  let tables: SchemaImportTableInput[];
  try {
    tables = mapInformationSchemaRowsToCatalog(query.rows, normalized.value.workspace, normalized.value);
  } catch {
    return { ok: false, status: 500, code: "schema_import_metadata_invalid",
      message: "BigQuery schema metadata did not match the requested import." };
  }
  const result = await importSchemaCatalog(
    env,
    {
      workspace: normalized.value.workspace,
      tables
    },
    actor
  );

  if (!result.ok) {
    return result;
  }

  return {
    ok: true,
    value: {
      ...result.value,
      projectId: normalized.value.projectId,
      dataset: normalized.value.dataset,
      tablePrefix: normalized.value.tablePrefix || null
    }
  };
}

export function buildInformationSchemaQuery(input: SchemaImportSource) {
  const tablePath = formatInformationSchemaPath(
    input.projectId,
    input.dataset,
    "TABLES"
  );
  const columnPath = formatInformationSchemaPath(
    input.projectId,
    input.dataset,
    "COLUMNS"
  );
  const prefixFilter = input.tablePrefix
    ? `\n    AND STARTS_WITH(table_name, '${escapeSqlString(
        input.tablePrefix
      )}')`
    : "";

  return `WITH selected_tables AS (
  SELECT table_catalog, table_schema, table_name, table_type
  FROM ${tablePath}
  WHERE table_type IN (${IMPORT_TABLE_TYPES.map(type => `'${type}'`).join(", ")})${prefixFilter}
  ORDER BY table_name
  LIMIT ${input.tableLimit}
)
SELECT
  selected_tables.table_catalog,
  selected_tables.table_schema,
  selected_tables.table_name,
  selected_tables.table_type,
  columns.column_name,
  columns.data_type,
  columns.is_nullable,
  columns.ordinal_position,
  ARRAY_TO_STRING(columns.policy_tags, ',') AS policy_tags
FROM selected_tables
JOIN ${columnPath} AS columns
USING (table_catalog, table_schema, table_name)
ORDER BY selected_tables.table_name, columns.ordinal_position`;
}

export function mapInformationSchemaRowsToCatalog(
  rows: BigQueryQueryRow[],
  workspace: string,
  source: SchemaImportSource
): SchemaImportTableInput[] {
  const tables = new Map<string, { table: SchemaImportTableInput; type: string;
    columns: Set<string>; positions: Set<number> }>();

  for (const row of rows) {
    const parsed = parseInformationSchemaRow(row);
    if (!parsed || parsed.table_catalog !== source.projectId || parsed.table_schema !== source.dataset ||
        !parsed.table_name.startsWith(source.tablePrefix)) {
      throw new Error("Invalid BigQuery schema metadata.");
    }

    const tableName = `${parsed.table_schema}.${parsed.table_name}`;
    const existing =
      tables.get(tableName) ??
      { type: parsed.table_type, columns: new Set<string>(), positions: new Set<number>(), table: {
        workspace,
        name: tableName,
        description: `${formatTableType(parsed.table_type)} imported from BigQuery INFORMATION_SCHEMA.`,
        rowCount: 0,
        fields: []
      } satisfies SchemaImportTableInput };
    if (existing.type !== parsed.table_type || existing.columns.has(parsed.column_name) ||
        (parsed.ordinal_position !== null && existing.positions.has(parsed.ordinal_position))) {
      throw new Error("Invalid BigQuery schema metadata.");
    }
    existing.columns.add(parsed.column_name);
    if (parsed.ordinal_position !== null) existing.positions.add(parsed.ordinal_position);
    const hasPolicyTags = Boolean(parsed.policy_tags);

    existing.table.fields.push({
      name: parsed.column_name,
      type: parsed.data_type,
      mode: parsed.is_nullable === "NO" ? "REQUIRED" : "NULLABLE",
      description: parsed.ordinal_position === null ? `Pseudo column from ${tableName}.`
        : `Column ${parsed.ordinal_position} from ${tableName}.`,
      pii: hasPolicyTags ? true : undefined,
      queryable: hasPolicyTags ? false : undefined,
      usedInExamples: false
    });
    tables.set(tableName, existing);
    if (tables.size > source.tableLimit) throw new Error("Invalid BigQuery schema metadata.");
  }

  return Array.from(tables.values(), value => value.table);
}

function normalizeImportInput(
  input: BigQuerySchemaImportInput,
  env: BigQueryEnv
):
  | {
      ok: true;
      value: SchemaImportSource & { workspace: string };
    }
  | {
      ok: false;
      status: 400 | 409 | 500;
      code: string;
      message: string;
    } {
  const projectId = (input.projectId || env.BIGQUERY_PROJECT_ID || "").trim();
  const dataset = input.dataset.trim();
  const workspace = normalizeWorkspace(input.workspace || dataset);
  const tablePrefix = (input.tablePrefix ?? "").trim();
  const tableLimit = normalizeTableLimit(input.tableLimit);

  if (!isSafeProjectId(projectId)) {
    return {
      ok: false,
      status: 400,
      code: "invalid_bigquery_project",
      message: "BigQuery project id is required and may contain letters, numbers, hyphens, colons, and periods only."
    };
  }

  if (!isSafeDatasetId(dataset)) {
    return {
      ok: false,
      status: 400,
      code: "invalid_bigquery_dataset",
      message: "BigQuery dataset is required and may contain letters, numbers, and underscores only."
    };
  }

  if (!isSafeWorkspace(workspace)) {
    return {
      ok: false,
      status: 400,
      code: "invalid_workspace",
      message: "Workspace may contain lowercase letters, numbers, underscores, and hyphens only."
    };
  }

  if (tablePrefix && !isSafeTablePrefix(tablePrefix)) {
    return {
      ok: false,
      status: 400,
      code: "invalid_table_prefix",
      message: "Table prefix may contain letters, numbers, and underscores only."
    };
  }

  return {
    ok: true,
    value: {
      workspace,
      projectId,
      dataset,
      tablePrefix,
      tableLimit
    }
  };
}

function parseInformationSchemaRow(
  row: BigQueryQueryRow
): InformationSchemaRow | null {
  if (!row || typeof row !== "object" || !METADATA_FIELDS.every(key => Object.hasOwn(row, key))) return null;
  const tableCatalog = getString(row.table_catalog);
  const tableSchema = getString(row.table_schema);
  const tableName = getString(row.table_name);
  const columnName = getString(row.column_name);
  const dataType = getString(row.data_type);
  const isNullable = getString(row.is_nullable);
  const tableType = getString(row.table_type);
  const ordinal = getOrdinalPosition(row.ordinal_position);
  const policyTags = row.policy_tags;

  if (
    !tableCatalog.trim() || !tableSchema.trim() || !tableName.trim() || !columnName.trim() || !dataType.trim() ||
    !IMPORT_TABLE_TYPES.includes(tableType) || !["YES", "NO"].includes(isNullable) || ordinal === undefined ||
    (policyTags !== null && (typeof policyTags !== "string" || (policyTags !== "" && !policyTags.trim())))
  ) {
    return null;
  }

  return {
    table_catalog: tableCatalog,
    table_schema: tableSchema,
    table_name: tableName,
    table_type: tableType,
    column_name: columnName,
    data_type: dataType,
    is_nullable: isNullable,
    ordinal_position: ordinal,
    policy_tags: policyTags
  };
}

function formatInformationSchemaPath(
  projectId: string,
  dataset: string,
  viewName: "TABLES" | "COLUMNS"
) {
  return `\`${projectId}.${dataset}.INFORMATION_SCHEMA.${viewName}\``;
}

function escapeSqlString(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function normalizeTableLimit(value: number | undefined) {
  if (!Number.isInteger(value) || !value || value < 1) {
    return DEFAULT_TABLE_LIMIT;
  }

  return Math.min(value, MAX_TABLE_LIMIT);
}

function normalizeWorkspace(value: string) {
  return value.trim().toLowerCase() || "demo";
}

function isSafeProjectId(value: string) {
  return /^[a-z][a-z0-9:.-]{4,127}$/i.test(value);
}

function isSafeDatasetId(value: string) {
  return /^[A-Za-z_][A-Za-z0-9_]{0,1023}$/.test(value);
}

function isSafeWorkspace(value: string) {
  return /^[a-z0-9_-]{1,80}$/.test(value);
}

function isSafeTablePrefix(value: string) {
  return /^[A-Za-z0-9_]{1,256}$/.test(value);
}

function formatTableType(value: string) {
  return value
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/^\w/, (match) => match.toUpperCase());
}

function getString(value: unknown) {
  return typeof value === "string" ? value : "";
}

function getOrdinalPosition(value: unknown): number | null | undefined {
  // INFORMATION_SCHEMA uses explicit NULL for pseudo columns, never a zero offset.
  if (value === null) return null;
  if (typeof value !== "number" && (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value))) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}
