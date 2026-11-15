import { canonicalControlJson, isSemanticRelease, sha256Text, type SemanticRelease } from "./control-objects";

export type PostgresParameterType = "INT64" | "DECIMAL" | "BOOL" | "STRING";
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

const casts: Record<PostgresParameterType, string> = { INT64: "int8", DECIMAL: "numeric", BOOL: "bool", STRING: "text" };

function postgresText(value: unknown, maximum: number): value is string {
  // pg serializes UTF-8: reject lone surrogates rather than silently hashing
  // one value and sending the Unicode replacement character to the database.
  return typeof value === "string" && value.length <= maximum && !value.includes("\0") &&
    new TextDecoder("utf-8", { ignoreBOM: true }).decode(new TextEncoder().encode(value)) === value;
}

function parameter(type: unknown, value: unknown): { cast: string; value: string | boolean | null } {
  if (typeof type !== "string" || !Object.hasOwn(casts, type)) throw new Error("Unsupported parameter type");
  const cast = "pg_catalog." + casts[type as PostgresParameterType];
  if (value === null) return { cast, value };
  if (type === "BOOL" && typeof value === "boolean") return { cast, value };
  if (type === "STRING" && postgresText(value, 4096)) return { cast, value };
  if (type === "INT64") {
    const text = typeof value === "number" && Number.isSafeInteger(value) && !Object.is(value, -0) ? String(value) : value;
    if (typeof text === "string" && /^-?(0|[1-9][0-9]{0,18})$/.test(text) && text !== "-0" &&
        BigInt(text) >= -9223372036854775808n && BigInt(text) <= 9223372036854775807n) return { cast, value: text };
  }
  if (type === "DECIMAL" && typeof value === "string" && value.length <= 128 &&
      /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value)) return { cast, value };
  throw new Error("Invalid PostgreSQL parameter");
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
      (d.measure.type === "INT64" || d.measure.type === "DECIMAL")) {
    aggregate = "pg_catalog.sum(" + postgresIdentifier(d.measure.column) + ")";
    columns.push({ name: d.measure.column as string, type: d.measure.type });
  } else throw new Error("Unsupported PostgreSQL measure");
  const values: (string | boolean | null)[] = [release.tenantId];
  const predicates = [postgresIdentifier(source.tenantColumn) + ' COLLATE "C" = $1::pg_catalog.text COLLATE "C"'];
  for (const name of names) {
    postgresIdentifier(name);
    const f = d.filters[name];
    if (!exact(f, ["column", "type"])) throw new Error("Invalid PostgreSQL filter");
    const p = parameter(f.type, a.parameters[name]);
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
