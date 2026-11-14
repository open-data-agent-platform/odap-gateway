import { visit } from "jsonc-parser";
import { canonicalControlJson, isControlTimestamp, sha256Text } from "./control-objects";
import type { ControlAccess } from "./control-storage";
import { proposeSemanticRevision } from "./semantic-candidate-storage";

export const SEMANTIC_METADATA_LIMIT = 8 * 1024 * 1024;
export const DBT_MANIFEST_SCHEMA = "https://schemas.getdbt.com/dbt/manifest/v12.json";
const formats = ["cube.rest-meta.v1", "dbt.manifest.v12"] as const;
type Format = typeof formats[number];
type Mapping = {
  sourceFormat: Format; sourceVersion: string; sourceInstance: string;
  containerId: string; resourceId: string; capturedAt: string;
  tenantId: string; revisionId: string; ownerId: string; definition: Record<string, unknown>;
};

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
}

function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function label(value: unknown, max = 256): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && value.trim() === value &&
    !/[\x00-\x1f\x7f]/.test(value);
}

function parse(text: string, limit: number, maxDepth = 64): unknown {
  if (typeof text !== "string" || new TextEncoder().encode(text).length > limit) throw new Error("Invalid import input");
  const stack: Array<Set<string> | null> = [];
  const enter = (keys: Set<string> | null) => {
    if (stack.length >= maxDepth) throw new Error("Import nesting too deep");
    stack.push(keys);
  };
  // Validate decoded property names before JSON.parse can discard duplicate keys.
  visit(text, {
    onObjectBegin() { enter(new Set()); },
    onObjectProperty(key) {
      const keys = stack.at(-1);
      if (!keys || keys.has(key)) throw new Error("Duplicate import property");
      keys.add(key);
    },
    onObjectEnd() { stack.pop(); },
    onArrayBegin() { enter(null); },
    onArrayEnd() { stack.pop(); },
    onLiteralValue(value: unknown) {
      if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Invalid import number");
    },
    onError() { throw new Error("Invalid import JSON"); },
  }, { disallowComments: true, allowTrailingComma: false, allowEmptyContent: false });
  if (stack.length) throw new Error("Invalid import JSON");
  return JSON.parse(text);
}

function readMapping(text: string): Mapping {
  const m = parse(text, 48 * 1024);
  if (!exact(m, ["sourceFormat", "sourceVersion", "sourceInstance", "containerId", "resourceId", "capturedAt",
    "tenantId", "revisionId", "ownerId", "definition"]) || !formats.includes(m.sourceFormat as Format) ||
    !label(m.sourceVersion) || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(m.sourceVersion) ||
    ![m.sourceInstance, m.containerId, m.resourceId, m.tenantId, m.revisionId, m.ownerId].every(v => label(v)) ||
    !isControlTimestamp(m.capturedAt)) throw new Error("Invalid metadata mapping");
  const d = m.definition;
  if (!exact(d, ["profile", "tenantId", "sourceRevision", "target", "metricId", "table", "measure", "filters"]) ||
    d.profile !== "odap.bigquery-metric.v1" || d.tenantId !== m.tenantId ||
    !label(d.sourceRevision) || !label(d.target) || !label(d.metricId) ||
    !object(d.table) || !object(d.measure) || !object(d.filters) || canonicalControlJson(d).length > 32_768) {
    throw new Error("Invalid mapped definition");
  }
  return m as Mapping;
}

function readCube(source: unknown, m: Mapping) {
  if (!object(source) || !Array.isArray(source.cubes)) throw new Error("Invalid Cube metadata");
  const containers = source.cubes.filter(cube => object(cube) && cube.name === m.containerId);
  if (containers.length !== 1) throw new Error("Ambiguous or missing Cube container");
  const container = containers[0] as Record<string, unknown>;
  if (!Array.isArray(container.measures) ||
    (container.type !== undefined && container.type !== "cube" && container.type !== "view")) {
    throw new Error("Invalid Cube container");
  }
  const members = container.measures.filter(member => object(member) && member.name === m.resourceId);
  const allMatches = source.cubes.flatMap(cube => object(cube) && Array.isArray(cube.measures) ? cube.measures : [])
    .filter(member => object(member) && member.name === m.resourceId);
  if (members.length !== 1 || allMatches.length !== 1) throw new Error("Ambiguous or missing Cube measure");
  const member = members[0] as Record<string, unknown>;
  if (typeof member.type !== "string" || !["number", "string", "time", "boolean"].includes(member.type) ||
    (member.aggType !== undefined && !label(member.aggType))) throw new Error("Invalid Cube measure");
  // Public flags, owner metadata and aggregation hints remain inert upstream context.
  return { kind: "cube-measure", containerId: m.containerId, resourceId: m.resourceId, type: member.type };
}

function readDbt(source: unknown, m: Mapping) {
  if (!object(source) || !object(source.metadata) || !object(source.metrics) ||
    source.metadata.dbt_schema_version !== DBT_MANIFEST_SCHEMA || source.metadata.dbt_version !== m.sourceVersion ||
    (source.disabled !== undefined && source.disabled !== null && !object(source.disabled))) {
    throw new Error("Unsupported dbt manifest metadata");
  }
  if (!Object.hasOwn(source.metrics, m.resourceId)) throw new Error("Missing dbt metric");
  const metric = source.metrics[m.resourceId];
  const matches = Object.values(source.metrics).filter(value => object(value) && value.unique_id === m.resourceId);
  if (!object(metric) || matches.length !== 1 || metric.unique_id !== m.resourceId ||
    metric.resource_type !== "metric" || metric.package_name !== m.containerId || !label(metric.name) ||
    metric.unique_id !== `metric.${m.containerId}.${metric.name}` || !object(metric.type_params) ||
    typeof metric.type !== "string" || !["simple", "ratio", "derived", "cumulative", "conversion"].includes(metric.type) ||
    !object(metric.config) || (metric.config.enabled !== undefined && metric.config.enabled !== true)) {
    throw new Error("Invalid or disabled dbt metric");
  }
  if (object(source.disabled) && Object.hasOwn(source.disabled, m.resourceId)) throw new Error("Disabled dbt metric conflict");
  return { kind: "dbt-metric", containerId: m.containerId, resourceId: m.resourceId, type: metric.type };
}

/** Pin an upstream snapshot and explicit local definition; never translate or execute SQL. */
export async function prepareSemanticMetadataImport(sourceJson: string, mappingJson: string) {
  const mapping = readMapping(mappingJson);
  const source = parse(sourceJson, SEMANTIC_METADATA_LIMIT);
  const selected = mapping.sourceFormat === "cube.rest-meta.v1" ? readCube(source, mapping) : readDbt(source, mapping);
  const evidence = {
    profile: "odap.semantic-metadata-import.v1", authenticity: "operator-supplied-unverified", gatewayState: "candidate",
    issuerAuthenticated: false, executionAuthorized: false, sourceDigest: await sha256Text(sourceJson),
    sourceJson, selected, mapping,
  };
  const evidenceDigest = await sha256Text(canonicalControlJson(evidence));
  return { evidence, evidenceDigest, proposal: {
    revisionId: mapping.revisionId, ownerId: mapping.ownerId,
    provenanceRef: "urn:odap:semantic-metadata-import:" + evidenceDigest,
    definitionJson: canonicalControlJson(mapping.definition),
  } };
}

export async function verifySemanticMetadataImport(bundleJson: string, expectedDigest: string) {
  if (typeof expectedDigest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(expectedDigest)) throw new Error("Invalid import pin");
  // The bundle adds wrapper objects around the already bounded mapping.
  const bundle = parse(bundleJson, 64 * 1024 * 1024, 68);
  if (!exact(bundle, ["evidence", "evidenceDigest", "proposal"]) || !object(bundle.evidence) ||
    typeof bundle.evidence.sourceJson !== "string") throw new Error("Invalid import bundle");
  const rebuilt = await prepareSemanticMetadataImport(bundle.evidence.sourceJson, canonicalControlJson(bundle.evidence.mapping));
  if (rebuilt.evidenceDigest !== expectedDigest || canonicalControlJson(rebuilt) !== canonicalControlJson(bundle)) {
    throw new Error("Import bundle mismatch");
  }
  return rebuilt;
}

export async function recordSemanticMetadataProposal(access: ControlAccess, bundleJson: string, expectedDigest: string) {
  const bundle = await verifySemanticMetadataImport(bundleJson, expectedDigest);
  if (bundle.evidence.mapping.tenantId !== access.tenantId) throw new Error("Import tenant mismatch");
  return proposeSemanticRevision(access, bundle.proposal);
}
