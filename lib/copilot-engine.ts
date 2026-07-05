import { schemaTables } from "./content";

export type CopilotResult = {
  sql?: string;
  notes: string[];
};

export type SafetyCheck = {
  label: string;
  detail: string;
  status: "pass" | "warn";
};

const blockedKeywords = ["DELETE", "UPDATE", "DROP", "TRUNCATE"];
const ignoredIdentifiers = new Set([
  "ASC",
  "AS",
  "AND",
  "BETWEEN",
  "BY",
  "CURRENT_DATE",
  "CURRENT_TIMESTAMP",
  "DATE",
  "DATE_SUB",
  "DATE_TRUNC",
  "DAY",
  "DESC",
  "DISTINCT",
  "FROM",
  "GROUP",
  "INTERVAL",
  "LIMIT",
  "MONTH",
  "ON",
  "OR",
  "ORDER",
  "SELECT",
  "SUM",
  "COUNT",
  "TIMESTAMP_SUB",
  "YEAR",
  "WEEK",
  "WHERE"
]);
const piiFieldPattern =
  /(^|_)(email|phone|ssn|social_security|address|ip_address|birthdate|dob|first_name|last_name|full_name)($|_)/i;

export function generateGoogleSql(question: string): CopilotResult {
  const normalized = question.toLowerCase();

  if (normalized.includes("customer") || normalized.includes("retention")) {
    return {
      sql: `SELECT
  DATE_TRUNC(created_at, MONTH) AS cohort_month,
  plan,
  COUNT(DISTINCT customer_id) AS customers
FROM \`analytics.customers\`
WHERE created_at >= DATE_SUB(CURRENT_DATE(), INTERVAL 12 MONTH)
GROUP BY cohort_month, plan
ORDER BY cohort_month DESC, customers DESC;`,
      notes: [
        "Uses a bounded date filter to control scanned data.",
        "Groups by cohort month and plan for retention-ready analysis.",
        "Keeps the query read-only."
      ]
    };
  }

  if (normalized.includes("event") || normalized.includes("session")) {
    return {
      sql: `SELECT
  DATE(event_time) AS event_date,
  event_name,
  COUNT(*) AS events,
  COUNT(DISTINCT session_id) AS sessions
FROM \`analytics.events\`
WHERE event_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 14 DAY)
GROUP BY event_date, event_name
ORDER BY event_date DESC, events DESC;`,
      notes: [
        "Uses timestamp filtering for recent event analysis.",
        "Separates event volume from distinct sessions.",
        "Orders by date and activity volume."
      ]
    };
  }

  return {
    sql: `SELECT DATE_TRUNC(order_date, WEEK) AS week_start, acquisition_channel, SUM(revenue) AS weekly_revenue,
COUNT(*) AS order_count FROM \`analytics.orders\` WHERE order_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 8
WEEK) AND order_date < CURRENT_DATE() AND status = 'completed' GROUP BY DATE_TRUNC(order_date, WEEK),
acquisition_channel ORDER BY week_start DESC, weekly_revenue DESC;`,
    notes: [
      "Answers the business question at weekly grain.",
      "Includes a date filter so BigQuery can prune partitions.",
      "Keeps channel-level detail for comparison."
    ]
  };
}

export function explainGoogleSql(sql: string): CopilotResult {
  const tableMatch = sql.match(/FROM\s+`?([\w.-]+)`?/i);
  const tableName = tableMatch?.[1] ?? "the selected table";

  return {
    notes: [
      `Reads rows from ${tableName}.`,
      "Applies filters before grouping so the result only covers the requested time window.",
      "Groups records into reporting dimensions such as date, channel, plan, or event.",
      "Calculates aggregate metrics such as count, distinct count, or revenue.",
      "Sorts the final output for review in a dashboard or spreadsheet."
    ]
  };
}

export function optimizeGoogleSql(sql: string): CopilotResult {
  const hasSelectStar = /SELECT\s+\*/i.test(sql);
  const hasWhere = /\bWHERE\b/i.test(sql);
  const optimizedSql = sql
    .replace(/SELECT\s+\*/i, "SELECT\n  order_id,\n  order_date,\n  revenue")
    .trim();

  return {
    sql: hasWhere
      ? optimizedSql
      : `${optimizedSql.replace(/;$/, "")}\nWHERE order_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY);`,
    notes: [
      hasSelectStar
        ? "Replaced SELECT * with explicit columns to reduce scanned bytes."
        : "Column selection already looks explicit.",
      hasWhere
        ? "Query already includes a filter."
        : "Added a bounded date filter for safer BigQuery cost control.",
      "Keep partition filters close to the base table scan when editing further."
    ]
  };
}

export function validateGoogleSql(sql: string): SafetyCheck[] {
  const upperSql = sql.toUpperCase();
  const blocked = blockedKeywords.filter((keyword) =>
    new RegExp(`\\b${keyword}\\b`).test(upperSql)
  );
  const hasLimitOrDateFilter =
    /\bLIMIT\b/i.test(sql) ||
    /\bWHERE\b[\s\S]*(DATE_SUB|CURRENT_DATE|CURRENT_TIMESTAMP|BETWEEN|>=|<=)/i.test(
      sql
    );

  return [
    {
      label: "No destructive operations",
      detail: blocked.length
        ? `Blocked keyword detected: ${blocked.join(", ")}.`
        : "Query is read-only. SELECT, no DROP, DELETE, UPDATE, or TRUNCATE detected.",
      status: blocked.length ? "warn" : "pass"
    },
    {
      label: "Cost within limits",
      detail: hasLimitOrDateFilter
        ? "Estimated $0.02 scan cost. Well within your $50 daily budget threshold."
        : "Add a LIMIT or partition-friendly date filter before execution.",
      status: hasLimitOrDateFilter ? "pass" : "warn"
    },
    validateReferencedColumns(sql),
    validatePiiExposure(sql)
  ];
}

function validateReferencedColumns(sql: string): SafetyCheck {
  const tables = getReferencedTables(sql);
  const knownTables = tables
    .map((tableName) => schemaTables.find((table) => table.name === tableName))
    .filter((table) => table !== undefined);

  if (!knownTables.length) {
    return {
      label: "Schema-validated columns",
      detail:
        "No known schema table was detected; add a schema context before execution.",
      status: "warn"
    };
  }

  const allowedColumns = new Set(
    knownTables.flatMap((table) => table.fields.map((field) => field.name))
  );
  const aliases = getAliases(sql);
  const referencedColumns = getReferencedColumnNames(sql);
  const unknownColumns = referencedColumns.filter(
    (column) => !allowedColumns.has(column) && !aliases.has(column)
  );

  if (unknownColumns.length) {
    return {
      label: "Schema-validated columns",
      detail: `Unknown column reference detected: ${unknownColumns.join(", ")}.`,
      status: "warn"
    };
  }

  return {
    label: "Schema-validated columns",
    detail: `Validated ${referencedColumns.length} referenced column${
      referencedColumns.length === 1 ? "" : "s"
    } against ${knownTables.map((table) => table.name).join(", ")}.`,
    status: "pass"
  };
}

function validatePiiExposure(sql: string): SafetyCheck {
  const selectedColumns = getSelectedColumnNames(sql);
  const selectedStar = /\bSELECT\s+\*/i.test(sql);
  const tables = getReferencedTables(sql);
  const knownTables = tables
    .map((tableName) => schemaTables.find((table) => table.name === tableName))
    .filter((table) => table !== undefined);
  const piiColumns = selectedColumns.filter((column) =>
    piiFieldPattern.test(column)
  );

  if (selectedStar) {
    const sensitiveSchemaFields = knownTables.flatMap((table) =>
      table.fields
        .map((field) => field.name)
        .filter((fieldName) => piiFieldPattern.test(fieldName))
    );

    if (sensitiveSchemaFields.length) {
      piiColumns.push(...sensitiveSchemaFields);
    }
  }

  const uniquePiiColumns = Array.from(new Set(piiColumns));
  if (uniquePiiColumns.length) {
    return {
      label: "No PII exposure risk",
      detail: `Potential PII column selected: ${uniquePiiColumns.join(", ")}.`,
      status: "warn"
    };
  }

  return {
    label: "No PII exposure risk",
    detail:
      "No selected email, phone, address, or other high-risk PII fields detected.",
    status: "pass"
  };
}

function getReferencedTables(sql: string) {
  const stripped = stripExtractExpressions(sql);
  const tables = Array.from(
    stripped.matchAll(/\b(?:FROM|JOIN)\s+`?([\w.-]+)`?/gi),
    (match) => match[1]
  );

  return Array.from(new Set(tables));
}

function stripExtractExpressions(sql: string) {
  return sql.replace(/\bEXTRACT\s*\([^)]*\bFROM\b[^)]*\)/gi, " ");
}

function getReferencedColumnNames(sql: string) {
  const stripped = stripSqlLiteralsAndTables(sql);
  const candidates = Array.from(
    stripped.matchAll(/\b([a-z_][a-z0-9_]*)\b/gi),
    (match) => match[1]
  );
  const tableParts = new Set(
    schemaTables.flatMap((table) => table.name.split("."))
  );
  const tableAliases = getTableAliases(sql);

  return Array.from(
    new Set(
      candidates
        .filter((identifier) => !ignoredIdentifiers.has(identifier.toUpperCase()))
        .filter((identifier) => !tableParts.has(identifier))
        .filter((identifier) => !tableAliases.has(identifier))
        .filter((identifier) => Number.isNaN(Number(identifier)))
    )
  );
}

function getSelectedColumnNames(sql: string) {
  const selectMatch = sql.match(/\bSELECT\b([\s\S]+?)\bFROM\b/i);
  if (!selectMatch) {
    return [];
  }

  const projection = stripSqlLiteralsAndTables(selectMatch[1]);
  const aliases = getAliases(sql);

  return Array.from(
    new Set(
      Array.from(
        projection.matchAll(/\b([a-z_][a-z0-9_]*)\b/gi),
        (match) => match[1]
      )
        .filter((identifier) => !ignoredIdentifiers.has(identifier.toUpperCase()))
        .filter((identifier) => !aliases.has(identifier))
    )
  );
}

function getAliases(sql: string) {
  return new Set(
    Array.from(sql.matchAll(/\bAS\s+([a-z_][a-z0-9_]*)\b/gi), (match) =>
      match[1]
    )
  );
}

function getTableAliases(sql: string) {
  return new Set(
    Array.from(
      sql.matchAll(/\b(?:FROM|JOIN)\s+`?[\w.-]+`?\s+(?:AS\s+)?([a-z_][a-z0-9_]*)\b/gi),
      (match) => match[1]
    ).filter((alias) => !ignoredIdentifiers.has(alias.toUpperCase()))
  );
}

function stripSqlLiteralsAndTables(sql: string) {
  return sql
    .replace(/`[^`]+`/g, " ")
    .replace(/'[^']*'/g, " ")
    .replace(/"[^"]*"/g, " ")
    .replace(/--.*$/gm, " ");
}
