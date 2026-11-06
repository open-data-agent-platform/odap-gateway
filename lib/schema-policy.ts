import {
  getSchemaPolicyCatalog,
  type AdminStorageEnv,
  type SchemaCatalogField,
  type SchemaCatalogTable,
  type StorageMode
} from "./admin-store";
import { getGateLabel, type QueryRunPreview } from "./phase2";
import type { SafetyCheck } from "./copilot-engine";
import { analyzePreviewSql } from "./preview-sql-policy";

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
  const references = analyzePreviewSql(sql);
  if (!references) {
    const detail = "SQL is invalid or outside the supported single-table preview profile.";
    return { workspace: normalizedWorkspace, source, referencedTables: [], blocked: true,
      reasons: [detail], checks: [...POLICY_CHECK_LABELS].map(label => ({ label, detail, status: "warn" })) };
  }
  const referencedTables = [references.table].map((tableName) => ({
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
  const referencedColumns = references.columns;
  const fieldIndex = createFieldIndex(allowedTables);
  const unknownColumns =
    allowedTables.length === 0
      ? []
      : referencedColumns.filter((column) => !fieldIndex.has(column));
  const selectedColumns = references.selectedColumns;
  const selectedStar = references.selectedStar;
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

function normalizeWorkspace(value: string) {
  return value.trim().toLowerCase() || "demo";
}

function normalizeTableName(value: string) {
  return value.trim().replace(/^`([^`]+)`$/, "$1");
}

function formatPolicyFields(fields: PolicyField[]) {
  return Array.from(new Set(fields.map(getQualifiedFieldName))).join(", ");
}

function getQualifiedFieldName(field: PolicyField) {
  return `${field.tableName}.${field.name}`;
}
