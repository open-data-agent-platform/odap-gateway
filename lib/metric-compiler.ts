import { canonicalControlJson, isSemanticRelease, sha256Text, type SemanticRelease } from "./control-objects";

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
}

function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return object(value) && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));
}

function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z_][A-Za-z_0-9]{0,127}$/.test(value)) {
    throw new Error("Unsupported metric identifier");
  }
  return value;
}

function parameter(type: unknown, value: unknown, index: number) {
  if (!((type === "INT64" && Number.isSafeInteger(value)) ||
        (type === "BOOL" && typeof value === "boolean") ||
        (type === "STRING" && typeof value === "string"))) throw new Error("Invalid metric parameter type or value");
  return { name: "p" + index, parameterType: { type }, parameterValue: { value: String(value) } };
}

// Compilation is pure apart from hashing: no warehouse calls, job options, or free-form SQL.
export async function compileReleasedMetric(release: SemanticRelease, definitionJson: string, canonicalAction: string,
  projectId: string) {
  if (!isSemanticRelease(release) || release.state !== "released" || typeof definitionJson !== "string" ||
      definitionJson.length > 32_768) throw new Error("Released metric definition required");
  const d: unknown = JSON.parse(definitionJson);
  const a: unknown = JSON.parse(canonicalAction);
  if (!exact(d, ["profile", "tenantId", "sourceRevision", "target", "metricId", "table", "measure", "filters"]) ||
      d.profile !== "odap.bigquery-metric.v1" || d.tenantId !== release.tenantId ||
      d.sourceRevision !== release.sourceRevision ||
      await sha256Text(canonicalControlJson(d)) !== release.definitionDigest) throw new Error("Metric release mismatch");
  if (!exact(a, ["profile", "target", "metricId", "parameters"]) || a.profile !== "odap.metric-read.v1" ||
      typeof a.target !== "string" || !a.target.trim() || a.target !== d.target ||
      typeof a.metricId !== "string" || !a.metricId.trim() || a.metricId !== d.metricId || !object(a.parameters)) {
    throw new Error("Metric action mismatch");
  }
  if (!exact(d.table, ["project", "dataset", "name"]) || d.table.project !== projectId ||
      !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId)) throw new Error("Unsupported metric source project");
  const table = [projectId, identifier(d.table.dataset), identifier(d.table.name)].join(".");
  let aggregate: string;
  if (exact(d.measure, ["aggregate"]) && d.measure.aggregate === "COUNT_ROWS") aggregate = "COUNT(*)";
  else if (exact(d.measure, ["aggregate", "column"]) && d.measure.aggregate === "SUM") {
    aggregate = "SUM(`" + identifier(d.measure.column) + "`)";
  } else throw new Error("Unsupported metric measure");

  if (!object(d.filters)) throw new Error("Invalid metric filters");
  const filters = d.filters;
  const params = a.parameters;
  const names = Object.keys(filters).sort();
  if (names.length > 16 || !exact(params, names)) throw new Error("Metric filters do not match");
  const predicates: string[] = [];
  const queryParameters = names.map((name, i) => {
    identifier(name);
    const filter = filters[name];
    if (!exact(filter, ["column", "type"])) throw new Error("Invalid metric filter");
    const param = parameter(filter.type, params[name], i);
    predicates.push("`" + identifier(filter.column) + "` = @" + param.name);
    return param;
  });
  const query = "SELECT " + aggregate + " AS metric_value FROM `" + table + "`" +
    (predicates.length ? " WHERE " + predicates.join(" AND ") : "");
  return { query, useLegacySql: false as const, parameterMode: "NAMED" as const, queryParameters };
}
