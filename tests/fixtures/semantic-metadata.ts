import { DBT_MANIFEST_SCHEMA } from "../../lib/semantic-metadata-import";
import metric from "./revenue-metric.json";

export const cubeMetadata = () => ({ cubes: [{ name: "orders", type: "cube", measures: [{
  name: "orders.net_revenue", type: "number", aggType: "sum", meta: { certified: true, owner: "upstream-owner" },
}], dimensions: [], segments: [] }] });

export const dbtManifest = () => ({
  metadata: { dbt_schema_version: DBT_MANIFEST_SCHEMA, dbt_version: "0.0.0-synthetic" },
  metrics: { "metric.demo.net_revenue": { name: "net_revenue", unique_id: "metric.demo.net_revenue",
    package_name: "demo", resource_type: "metric", type: "simple", config: { enabled: true },
    path: "metrics.yml", original_file_path: "models/metrics.yml", fqn: ["demo", "net_revenue"],
    description: "Synthetic fixture, not a dbt invocation", label: "Net revenue",
    type_params: { measure: { name: "net_revenue" } }, meta: { owner: "upstream-owner" } } },
  disabled: {}, nodes: {}, sources: {}, macros: {}, docs: {}, exposures: {}, groups: {}, selectors: {},
  parent_map: {}, child_map: {}, group_map: {}, saved_queries: {}, semantic_models: {}, unit_tests: {},
});

export const metadataSource = (kind: "cube" | "dbt") => kind === "cube" ? cubeMetadata() : dbtManifest();
export const metadataMapping = (kind: "cube" | "dbt") => ({
  sourceFormat: kind === "cube" ? "cube.rest-meta.v1" : "dbt.manifest.v12", sourceVersion: "0.0.0-synthetic",
  sourceInstance: "synthetic-offline", containerId: kind === "cube" ? "orders" : "demo",
  resourceId: kind === "cube" ? "orders.net_revenue" : "metric.demo.net_revenue",
  capturedAt: "2026-11-14T00:00:00.000Z", tenantId: "t", revisionId: `${kind}-revision`, ownerId: "owner",
  definition: structuredClone(metric),
});
