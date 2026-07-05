import {
  getSchemaPolicyCatalog,
  type AdminStorageEnv,
  type SchemaCatalogField,
  type SchemaCatalogTable,
  type StorageMode
} from "./admin-store";
import { getGateLabel, type QueryRunPreview } from "./phase2";
import type { SafetyCheck } from "./copilot-engine";

export type SchemaPolicyEvaluation = {
  workspace: string;
  source: StorageMode;
  referencedTables: string[];
  checks: SafetyCheck[];
  blocked: boolean;
  reasons: string[];
};

type ReferencedTable = {
  original: string;
  normalized: string;
};

type PolicyField = SchemaCatalogField & {
  tableName: string;
};

const POLICY_CHECK_LABELS = new Set([
  "Workspace table allowlist",
  "Schema-validated columns",
  "No PII exposure risk"
]);

const ignoredIdentifiers = new Set([
  "ALL",
  "AND",
  "ANY",
  "ARRAY",
  "ARRAY_AGG",
  "AS",
  "ASC",
  "BETWEEN",
  "BOOL",
  "BY",
  "CASE",
  "CAST",
  "COALESCE",
  "COUNT",
  "CURRENT_DATE",
  "CURRENT_TIMESTAMP",
  "DATE",
  "DATE_SUB",
  "DATE_TRUNC",
  "DAY",
  "DESC",
  "DISTINCT",
  "ELSE",
  "END",
  "EXCEPT",
  "EXTRACT",
  "FALSE",
  "FLOAT64",
  "FOLLOWING",
  "FROM",
  "FULL",
  "GROUP",
  "HAVING",
  "IF",
  "IFNULL",
  "INNER",
  "IN",
  "INT64",
  "INTERVAL",
  "ISOWEEK",
  "IS",
  "JSON_QUERY",
  "JSON_VALUE",
  "JOIN",
  "LAG",
  "LEFT",
  "LIKE",
  "LIMIT",
  "MONTH",
  "NOT",
  "NULL",
  "NUMERIC",
  "ON",
  "OR",
  "ORDER",
  "OUTER",
  "OVER",
  "PARTITION",
  "PRECEDING",
  "RIGHT",
  "ROW_NUMBER",
  "ROWS",
  "SAFE_CAST",
  "SELECT",
  "STRING",
  "SUM",
  "THEN",
  "TIMESTAMP",
  "TIMESTAMP_SUB",
  "TRUE",
  "UNBOUNDED",
  "WEEK",
  "WHEN",
  "WHERE",
  "YEAR"
]);

export async function evaluateSchemaPolicy(
  env: AdminStorageEnv,
  input: {
    sql: string;
    workspace: string;
  }
) {
  const catalog = await getSchemaPolicyCatalog(env);

  return evaluateSchemaCatalog(
    input.sql,
    input.workspace,
    catalog.tables,
    catalog.source
  );
}

export function evaluateSchemaCatalog(
  sql: string,
  workspace: string,
  catalog: SchemaCatalogTable[],
  source: StorageMode = "seed"
): SchemaPolicyEvaluation {
  const normalizedWorkspace = normalizeWorkspace(workspace);
  const referencedTables = getReferencedTables(sql).map((tableName) => ({
    original: tableName,
    normalized: normalizeTableName(tableName)
  }));
  const workspaceCatalog = catalog.filter(
    (table) => normalizeWorkspace(table.workspace) === normalizedWorkspace
  );
  const workspaceTables = new Map(
    workspaceCatalog.map((table) => [normalizeTableName(table.name), table])
  );
  const knownTables = new Map(
    catalog.map((table) => [normalizeTableName(table.name), table])
  );
  const allowedTables = referencedTables
    .map((table) => workspaceTables.get(table.normalized))
    .filter((table) => table !== undefined);
  const blockedTables = referencedTables.filter(
    (table) => !workspaceTables.has(table.normalized)
  );
  const blockedTableNames = blockedTables.map((table) => table.original);
  const referencedColumns = getReferencedColumnNames(sql, catalog);
  const fieldIndex = createFieldIndex(allowedTables);
  const unknownColumns =
    allowedTables.length === 0
      ? []
      : referencedColumns.filter((column) => !fieldIndex.has(column));
  const selectedColumns = getSelectedColumnNames(sql);
  const selectedStar = hasSelectStar(sql);
  const referencedPolicyFields = getPolicyFieldsByName(
    referencedColumns,
    fieldIndex
  );
  const selectedPolicyFields = selectedStar
    ? allowedTables.flatMap((table) => toPolicyFields(table))
    : getPolicyFieldsByName(selectedColumns, fieldIndex);
  const nonQueryableFields = Array.from(
    new Map(
      [
        ...(selectedStar
          ? allowedTables.flatMap((table) =>
              toPolicyFields(table).filter((field) => !field.queryable)
            )
          : []),
        ...referencedPolicyFields.filter((field) => !field.queryable)
      ].map((field) => [getQualifiedFieldName(field), field])
    ).values()
  );
  const piiFields = selectedPolicyFields.filter((field) => field.pii);
  const knownOutsideWorkspace = blockedTables.filter((table) =>
    knownTables.has(table.normalized)
  );
  const workspaceCheck = createWorkspaceCheck({
    workspace: normalizedWorkspace,
    source,
    referencedTables,
    blockedTableNames,
    knownOutsideWorkspace: knownOutsideWorkspace.map((table) => table.original)
  });
  const schemaCheck = createSchemaCheck({
    workspace: normalizedWorkspace,
    allowedTables,
    referencedColumns,
    unknownColumns,
    nonQueryableFields,
    blockedTableNames
  });
  const piiCheck = createPiiCheck(piiFields);
  const checks = [workspaceCheck, schemaCheck, piiCheck];
  const reasons = [
    ...blockedTableNames.map(
      (tableName) =>
        `${tableName} is not in the ${normalizedWorkspace} workspace allowlist`
    ),
    ...unknownColumns.map((column) => `${column} is not in the schema catalog`),
    ...nonQueryableFields.map(
      (field) => `${getQualifiedFieldName(field)} is not queryable`
    ),
    ...piiFields.map((field) => `${getQualifiedFieldName(field)} is marked PII`)
  ];

  return {
    workspace: normalizedWorkspace,
    source,
    referencedTables: referencedTables.map((table) => table.original),
    checks,
    blocked: reasons.length > 0,
    reasons: Array.from(new Set(reasons))
  };
}

export function applySchemaPolicyToDryRunPreview(
  preview: QueryRunPreview,
  evaluation: SchemaPolicyEvaluation
): QueryRunPreview {
  const staticChecks = preview.checks.filter(
    (check) => !POLICY_CHECK_LABELS.has(check.label)
  );
  const checks = [...staticChecks, ...evaluation.checks];
  const hasPolicyWarning = evaluation.checks.some(
    (check) => check.status === "warn"
  );
  const status = evaluation.blocked
    ? "blocked"
    : preview.status === "approved" && hasPolicyWarning
      ? "needs_approval"
      : preview.status;

  return {
    ...preview,
    status,
    gateLabel: getGateLabel(status),
    scannedBytes: evaluation.blocked ? 0 : preview.scannedBytes,
    estimatedCostUsd: evaluation.blocked ? 0 : preview.estimatedCostUsd,
    expectedRuntimeMs: evaluation.blocked ? 0 : preview.expectedRuntimeMs,
    referencedTables: preview.referencedTables.length
      ? preview.referencedTables
      : evaluation.referencedTables,
    checks,
    error: evaluation.blocked
      ? {
          code: "schema_policy_blocked",
          message: `Blocked by schema policy: ${evaluation.reasons.join("; ")}.`
        }
      : preview.error
  };
}

function createWorkspaceCheck(input: {
  workspace: string;
  source: StorageMode;
  referencedTables: ReferencedTable[];
  blockedTableNames: string[];
  knownOutsideWorkspace: string[];
}): SafetyCheck {
  if (!input.referencedTables.length) {
    return {
      label: "Workspace table allowlist",
      detail: `No table reference was detected for workspace ${input.workspace}; admin review is required.`,
      status: "warn"
    };
  }

  if (input.blockedTableNames.length) {
    const suffix = input.knownOutsideWorkspace.length
      ? " Some blocked tables exist in another workspace catalog."
      : "";

    return {
      label: "Workspace table allowlist",
      detail: `Blocked table outside ${input.workspace} allowlist: ${input.blockedTableNames.join(
        ", "
      )}.${suffix}`,
      status: "warn"
    };
  }

  return {
    label: "Workspace table allowlist",
    detail: `All referenced tables are allowed for workspace ${input.workspace} using ${input.source} schema policy.`,
    status: "pass"
  };
}

function createSchemaCheck(input: {
  workspace: string;
  allowedTables: SchemaCatalogTable[];
  referencedColumns: string[];
  unknownColumns: string[];
  nonQueryableFields: PolicyField[];
  blockedTableNames: string[];
}): SafetyCheck {
  if (input.blockedTableNames.length) {
    return {
      label: "Schema-validated columns",
      detail:
        "Column validation is blocked because at least one table is outside the workspace allowlist.",
      status: "warn"
    };
  }

  if (!input.allowedTables.length) {
    return {
      label: "Schema-validated columns",
      detail: `No allowed schema table was detected for workspace ${input.workspace}; add schema context before execution.`,
      status: "warn"
    };
  }

  if (input.unknownColumns.length) {
    return {
      label: "Schema-validated columns",
      detail: `Unknown column reference detected: ${input.unknownColumns.join(
        ", "
      )}.`,
      status: "warn"
    };
  }

  if (input.nonQueryableFields.length) {
    return {
      label: "Schema-validated columns",
      detail: `Blocked by non-queryable field policy: ${formatPolicyFields(
        input.nonQueryableFields
      )}.`,
      status: "warn"
    };
  }

  return {
    label: "Schema-validated columns",
    detail: `Validated ${input.referencedColumns.length} referenced column${
      input.referencedColumns.length === 1 ? "" : "s"
    } against ${input.allowedTables.map((table) => table.name).join(", ")}.`,
    status: "pass"
  };
}

function createPiiCheck(piiFields: PolicyField[]): SafetyCheck {
  if (piiFields.length) {
    return {
      label: "No PII exposure risk",
      detail: `Blocked selected PII field: ${formatPolicyFields(piiFields)}.`,
      status: "warn"
    };
  }

  return {
    label: "No PII exposure risk",
    detail: "No selected fields marked as PII by Phase 4 schema policy.",
    status: "pass"
  };
}

function getReferencedTables(sql: string) {
  const stripped = stripExtractExpressions(sql);

  return Array.from(
    stripped.matchAll(/\b(?:FROM|JOIN)\s+`?([\w.-]+)`?/gi),
    (match) => match[1]
  );
}

function getReferencedColumnNames(
  sql: string,
  catalog: SchemaCatalogTable[]
) {
  const stripped = stripSqlLiteralsAndTables(sql);
  const tableParts = new Set(
    catalog.flatMap((table) => normalizeTableName(table.name).split("."))
  );
  const tableAliases = getTableAliases(sql);
  const columnAliases = getAliases(sql);

  return Array.from(
    new Set(
      Array.from(
        stripped.matchAll(/\b([a-z_][a-z0-9_]*)\b/gi),
        (match) => match[1].toLowerCase()
      )
        .filter((identifier) => !ignoredIdentifiers.has(identifier.toUpperCase()))
        .filter((identifier) => !tableParts.has(identifier.toLowerCase()))
        .filter((identifier) => !tableAliases.has(identifier))
        .filter((identifier) => !columnAliases.has(identifier))
        .filter((identifier) => Number.isNaN(Number(identifier)))
    )
  );
}

function getSelectedColumnNames(sql: string) {
  const projection = getSelectProjection(sql);
  if (!projection) {
    return [];
  }

  const aliases = getAliases(sql);

  return Array.from(
    new Set(
      Array.from(
        stripSqlLiteralsAndTables(projection).matchAll(
          /\b([a-z_][a-z0-9_]*)\b/gi
        ),
        (match) => match[1].toLowerCase()
      )
        .filter((identifier) => !ignoredIdentifiers.has(identifier.toUpperCase()))
        .filter((identifier) => !aliases.has(identifier))
    )
  );
}

function getSelectProjection(sql: string) {
  const selectMatch = sql.match(/\bSELECT\b([\s\S]+?)\bFROM\b/i);

  return selectMatch?.[1] ?? "";
}

function hasSelectStar(sql: string) {
  const projection = getSelectProjection(sql).replace(
    /\bCOUNT\s*\(\s*\*\s*\)/gi,
    " "
  );

  return /(^|,)\s*(?:[a-z_][a-z0-9_]*\.)?\*\s*(?:,|$)/i.test(projection);
}

function createFieldIndex(tables: SchemaCatalogTable[]) {
  const index = new Map<string, PolicyField[]>();

  for (const table of tables) {
    for (const field of toPolicyFields(table)) {
      const fields = index.get(field.name) ?? [];
      fields.push(field);
      index.set(field.name, fields);
    }
  }

  return index;
}

function getPolicyFieldsByName(
  names: string[],
  fieldIndex: Map<string, PolicyField[]>
) {
  return names.flatMap((name) => fieldIndex.get(name) ?? []);
}

function toPolicyFields(table: SchemaCatalogTable): PolicyField[] {
  return table.fields.map((field) => ({
    ...field,
    name: field.name.toLowerCase(),
    tableName: table.name
  }));
}

function getAliases(sql: string) {
  return new Set(
    Array.from(sql.matchAll(/\bAS\s+([a-z_][a-z0-9_]*)\b/gi), (match) =>
      match[1].toLowerCase()
    )
  );
}

function getTableAliases(sql: string) {
  return new Set(
    Array.from(
      sql.matchAll(
        /\b(?:FROM|JOIN)\s+`?[\w.-]+`?\s+(?:AS\s+)?([a-z_][a-z0-9_]*)\b/gi
      ),
      (match) => match[1]
    )
      .filter((alias) => !ignoredIdentifiers.has(alias.toUpperCase()))
      .map((alias) => alias.toLowerCase())
  );
}

function stripSqlLiteralsAndTables(sql: string) {
  return sql
    .replace(/\bEXTRACT\s*\([^)]*\bFROM\b[^)]*\)/gi, " ")
    .replace(/`[^`]+`/g, " ")
    .replace(/'[^']*'/g, " ")
    .replace(/"[^"]*"/g, " ")
    .replace(/--.*$/gm, " ");
}

function stripExtractExpressions(sql: string) {
  return sql.replace(/\bEXTRACT\s*\([^)]*\bFROM\b[^)]*\)/gi, " ");
}

function normalizeWorkspace(value: string) {
  return value.trim().toLowerCase() || "analytics";
}

function normalizeTableName(value: string) {
  const parts = value
    .replace(/`/g, "")
    .trim()
    .toLowerCase()
    .split(".")
    .filter(Boolean);

  if (parts.length >= 2) {
    return parts.slice(-2).join(".");
  }

  return parts[0] ?? "";
}

function formatPolicyFields(fields: PolicyField[]) {
  return Array.from(new Set(fields.map(getQualifiedFieldName))).join(", ");
}

function getQualifiedFieldName(field: PolicyField) {
  return `${field.tableName}.${field.name}`;
}
