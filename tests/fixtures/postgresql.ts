import { canonicalControlJson, sha256Text, type SemanticRelease } from "../../lib/control-objects";

export function postgresBarrier() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

export const postgresSource = { database: "odap_pg_fixture", schema: "metrics", table: "orders", tenantColumn: "tenant_id" };
export const postgresDefinition = {
  profile: "odap.postgresql-metric.v1", tenantId: "tenant-a", sourceRevision: "revision-1", target: "orders", metricId: "total",
  table: { database: postgresSource.database, schema: postgresSource.schema, name: postgresSource.table, tenantColumn: "tenant_id" },
  measure: { aggregate: "COUNT_ROWS" }, filters: {},
};

export async function postgresRead(definition: unknown = postgresDefinition, parameters: Record<string, unknown> = {},
  override: Partial<SemanticRelease> = {}) {
  const release: SemanticRelease = { schemaVersion: "0.1", tenantId: "tenant-a", id: "release-1", owner: "fixture-owner",
    sourceRevision: "revision-1", state: "released", definitionDigest: await sha256Text(canonicalControlJson(definition)), ...override };
  return { release, definitionJson: JSON.stringify(definition), source: { ...postgresSource },
    canonicalAction: canonicalControlJson({ profile: "odap.metric-read.v1", target: "orders", metricId: "total", parameters }) };
}
