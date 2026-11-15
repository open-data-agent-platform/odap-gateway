import { canonicalControlJson, isSemanticRelease, sha256Text, type SemanticRelease } from "./control-objects";
import { postgresParameter, postgresText, type PostgresParameterType } from "./postgresql-parameter";

export type { PostgresParameterType } from "./postgresql-parameter";
export type PostgresSource = Readonly<{ database: string; schema: string; table: string; tenantColumn: string }>;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
}

function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return object(value) && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));
}

export function postgresIdentifier(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z_][A-Za-z_0-9]{0,62}$/.test(value)) {
    throw new Error("Unsupported PostgreSQL identifier");
  }
  return '"' + value + '"';
}

// A local Gateway engineering format, not an extension of the ODAP specification.
export async function compilePostgresMetric(release: SemanticRelease, definitionJson: string,
  canonicalAction: string, source: PostgresSource) {
  if (!isSemanticRelease(release) || !postgresText(release.tenantId, 256) || release.state !== "released" || typeof definitionJson !== "string" ||
      definitionJson.length > 32768 || typeof canonicalAction !== "string" || canonicalAction.length > 65536 ||
      !exact(source, ["database", "schema", "table", "tenantColumn"])) throw new Error("Invalid PostgreSQL read binding");
  for (const value of Object.values(source)) postgresIdentifier(value);
  const d: unknown = JSON.parse(definitionJson), a: unknown = JSON.parse(canonicalAction);
  if (!exact(d, ["profile", "tenantId", "sourceRevision", "target", "metricId", "table", "measure", "filters"]) ||
      d.profile !== "odap.postgresql-metric.v1" || d.tenantId !== release.tenantId ||
      d.sourceRevision !== release.sourceRevision || await sha256Text(canonicalControlJson(d)) !== release.definitionDigest ||
      !exact(d.table, ["database", "schema", "name", "tenantColumn"]) || d.table.database !== source.database ||
      d.table.schema !== source.schema || d.table.name !== source.table || d.table.tenantColumn !== source.tenantColumn) {
    throw new Error("PostgreSQL release mismatch");
  }
  if (!exact(a, ["profile", "target", "metricId", "parameters"]) || a.profile !== "odap.metric-read.v1" ||
      typeof a.target !== "string" || !a.target.trim() || a.target !== d.target ||
      typeof a.metricId !== "string" || !a.metricId.trim() || a.metricId !== d.metricId || !object(a.parameters) ||
      !object(d.filters)) throw new Error("PostgreSQL action mismatch");
  const names = Object.keys(d.filters).sort();
  if (names.length > 16 || !exact(a.parameters, names)) throw new Error("PostgreSQL filters mismatch");
  const columns: { name: string; type: PostgresParameterType }[] = [{ name: source.tenantColumn, type: "STRING" }];
  let aggregate: string;
  if (exact(d.measure, ["aggregate"]) && d.measure.aggregate === "COUNT_ROWS") aggregate = "pg_catalog.count(*)";
  else if (exact(d.measure, ["aggregate", "column", "type"]) && d.measure.aggregate === "SUM" &&
      ["INT16", "INT32", "INT64", "DECIMAL"].includes(d.measure.type as string)) {
    aggregate = "pg_catalog.sum(" + postgresIdentifier(d.measure.column) + ")";
    columns.push({ name: d.measure.column as string, type: d.measure.type as PostgresParameterType });
  } else throw new Error("Unsupported PostgreSQL measure");
  const values: (string | boolean | null)[] = [release.tenantId];
  const predicates = [postgresIdentifier(source.tenantColumn) + ' COLLATE "C" = $1::pg_catalog.text COLLATE "C"'];
  for (const name of names) {
    postgresIdentifier(name);
    const f = d.filters[name];
    if (!exact(f, ["column", "type"])) throw new Error("Invalid PostgreSQL filter");
    const p = postgresParameter(f.type, a.parameters[name]);
    values.push(p.value);
    predicates.push(postgresIdentifier(f.column) + " IS NOT DISTINCT FROM $" + values.length + "::" + p.cast);
    columns.push({ name: f.column as string, type: f.type as PostgresParameterType });
  }
  const relation = postgresIdentifier(source.schema) + "." + postgresIdentifier(source.table);
  const text = "SELECT " + aggregate + " AS metric_value FROM ONLY " + relation + " WHERE " + predicates.join(" AND ");
  return Object.freeze({ text, relation, values: Object.freeze(values),
    columns: Object.freeze(columns.map(c => Object.freeze(c))),
    statementDigest: await sha256Text(canonicalControlJson({ text, values, database: source.database })),
    actionDigest: await sha256Text(canonicalControlJson(a)), definitionDigest: release.definitionDigest });
}
