import { canonicalControlJson, isControlTimestamp, sha256Text } from "./control-objects";
import type { ControlAccess } from "./control-storage";
import { proposeSemanticRevision } from "./semantic-candidate-storage";

export const NVIDIA_IMPORT_COMMIT = "c447003f72a822301e927196a4ecb5b597c308d5";
export const NVIDIA_IMPORT_LIMIT = 128 * 1024;
const repository = "https://github.com/NVIDIA/auto-ontology";
const profile = "odap.nvidia-sql-attribute-import.v1";

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

function parse(text: string, limit: number): unknown {
  if (typeof text !== "string" || new TextEncoder().encode(text).length > limit) throw new Error("Invalid import input");
  return JSON.parse(text);
}

// The pinned API is a data envelope, not the YAML model interchange (which loses certification).
function readAttribute(value: unknown) {
  if (!exact(value, ["data"]) || !object(value.data)) throw new Error("Invalid upstream response");
  const data = value.data;
  const fields = ["id", "name", "description", "description_suggestion", "expression", "source", "sql", "sql_id",
    "certified", "term_id", "term_name", "database_name", "owner_id", "zones", "tags", "created", "modified",
    "created_by", "modified_by"];
  if (Object.keys(data).some(key => !fields.includes(key)) || !label(data.id) || !label(data.name) ||
      typeof data.expression !== "string" || !data.expression.trim() || data.expression.length > 32_768 ||
      typeof data.sql !== "string" || !data.sql.trim() || data.sql.length > 32_768) throw new Error("Invalid upstream attribute");
  for (const key of fields.filter(key => !["certified", "zones", "tags"].includes(key))) {
    if (data[key] !== undefined && data[key] !== null && typeof data[key] !== "string") throw new Error("Invalid upstream field");
  }
  if (data.certified !== undefined && data.certified !== null && typeof data.certified !== "boolean") {
    throw new Error("Invalid upstream certification");
  }
  for (const key of ["zones", "tags"]) {
    if (data[key] !== undefined && data[key] !== null && !Array.isArray(data[key])) throw new Error("Invalid upstream metadata");
  }
  return data;
}

/** Stages untrusted context and an explicit operator mapping; does not authenticate or run SQL. */
export async function prepareNvidiaSemanticImport(sourceJson: string, mappingJson: string) {
  const attribute = readAttribute(parse(sourceJson, NVIDIA_IMPORT_LIMIT));
  const mapping = parse(mappingJson, 48 * 1024);
  if (!exact(mapping, ["upstreamCommit", "sourceInstance", "attributeId", "capturedAt", "tenantId", "revisionId", "ownerId", "definition"]) ||
      mapping.upstreamCommit !== NVIDIA_IMPORT_COMMIT || !label(mapping.sourceInstance) ||
      mapping.attributeId !== attribute.id || !isControlTimestamp(mapping.capturedAt) ||
      !label(mapping.tenantId) || !label(mapping.revisionId) || !label(mapping.ownerId)) throw new Error("Invalid import mapping");
  const definition = mapping.definition;
  if (!exact(definition, ["profile", "tenantId", "sourceRevision", "target", "metricId", "table", "measure", "filters"]) ||
      definition.profile !== "odap.bigquery-metric.v1" || definition.tenantId !== mapping.tenantId ||
      !label(definition.sourceRevision) || !label(definition.target) || !label(definition.metricId) ||
      !object(definition.table) || !object(definition.measure) || !object(definition.filters)) throw new Error("Invalid mapped definition");
  const definitionJson = canonicalControlJson(definition);
  if (definitionJson.length > 32_768) throw new Error("Mapped definition too large");
  const evidence = {
    profile, repository, upstreamCommit: NVIDIA_IMPORT_COMMIT,
    authenticity: "operator-supplied-unverified", gatewayState: "candidate",
    certification: attribute.certified === true ? "upstream-certified" :
      attribute.certified === false ? "upstream-uncertified" : "upstream-unknown",
    sourceDigest: await sha256Text(sourceJson), sourceJson, mapping,
  };
  // Pin the complete source text AND the local mapping, not just an upstream object ID.
  const evidenceDigest = await sha256Text(canonicalControlJson(evidence));
  return { evidence, evidenceDigest, proposal: { revisionId: mapping.revisionId, ownerId: mapping.ownerId,
    provenanceRef: "urn:odap:nvidia-import:" + evidenceDigest, definitionJson } };
}

export async function verifyNvidiaSemanticImport(bundleJson: string, expectedDigest: string) {
  if (typeof expectedDigest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(expectedDigest)) throw new Error("Invalid import pin");
  const bundle = parse(bundleJson, 512 * 1024);
  if (!exact(bundle, ["evidence", "evidenceDigest", "proposal"]) || !object(bundle.evidence) ||
      typeof bundle.evidence.sourceJson !== "string") throw new Error("Invalid import bundle");
  const rebuilt = await prepareNvidiaSemanticImport(bundle.evidence.sourceJson, canonicalControlJson(bundle.evidence.mapping));
  if (rebuilt.evidenceDigest !== expectedDigest || canonicalControlJson(bundle) !== canonicalControlJson(rebuilt)) {
    throw new Error("Import bundle mismatch");
  }
  return rebuilt;
}

// Trusted callers provide authenticated ControlAccess and retain the independently pinned bundle.
// Upstream owners/zones/certification never confer local membership, validation or approval.
export async function recordNvidiaSemanticProposal(access: ControlAccess, bundleJson: string, expectedDigest: string) {
  const bundle = await verifyNvidiaSemanticImport(bundleJson, expectedDigest);
  if (bundle.evidence.mapping.tenantId !== access.tenantId) throw new Error("Import tenant mismatch");
  return proposeSemanticRevision(access, bundle.proposal);
}
