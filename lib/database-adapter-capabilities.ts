import { isResourceUnit, positiveSafeInteger, type ResourceUnit } from "./adapter-resource-budget";

type Capability = {
  engine: string;
  implementation: "implemented" | "not-implemented";
  validation: "offline-only" | "none";
  adapterRevision: string | null;
  providerInterface: string | null;
  actions: readonly string[];
  queryHardLimits: readonly ResourceUnit[];
  evidence: readonly string[];
};

// Inventory of repository implementations, not provider certification or an
// authorization registry. No runtime dispatch path imports this module.
const entries: Capability[] = [
  {
    engine: "bigquery", implementation: "implemented", validation: "offline-only",
    adapterRevision: "bigquery-metric-read.v1", providerInterface: "BigQuery REST v2; host-injected transport",
    actions: ["odap.metric-read.v1"], queryHardLimits: ["billed-bytes"],
    evidence: ["lib/dispatch-authority.ts", "lib/bigquery-governed-transport.ts",
      "lib/bigquery-byte-ceiling.ts", "tests/bigquery-byte-ceiling.test.ts", "tests/metric-compiler.test.ts"],
  },
  ...["postgresql", "clickhouse", "trino", "mysql", "mariadb", "duckdb", "sqlite"].map(engine => ({
    engine, implementation: "not-implemented" as const, validation: "none" as const, adapterRevision: null,
    providerInterface: null, actions: [], queryHardLimits: [], evidence: [],
  })),
];
const inventory: readonly Readonly<Capability>[] = Object.freeze(entries.map(entry => Object.freeze({
  ...entry, actions: Object.freeze(entry.actions), queryHardLimits: Object.freeze(entry.queryHardLimits),
  evidence: Object.freeze(entry.evidence),
})));

export function databaseAdapterInventory(): readonly Readonly<Capability>[] { return inventory; }

export type CapabilityAssessment = {
  schemaVersion: "adapter-capability-assessment.v1";
  offlineAssessment: true;
  authorizationGranted: false;
  compatible: boolean;
  reasons: string[];
};

function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
}

// Input is deliberately small. In particular it cannot assert capabilities,
// supply credentials, choose an endpoint, or claim independent verification.
export function assessDatabaseReadCapabilities(input: unknown): CapabilityAssessment {
  const result = (reasons: string[]): CapabilityAssessment => ({ schemaVersion: "adapter-capability-assessment.v1",
    offlineAssessment: true, authorizationGranted: false, compatible: reasons.length === 0, reasons });
  if (!plain(input) || Object.keys(input).length !== 5 ||
      !["schemaVersion", "engine", "action", "requireProviderVerification", "limits"].every(k => Object.hasOwn(input, k)) ||
      input.schemaVersion !== "adapter-read-requirements.v1" ||
      typeof input.engine !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(input.engine) ||
      typeof input.action !== "string" || !/^[a-z][a-z0-9.-]{0,95}$/.test(input.action) ||
      typeof input.requireProviderVerification !== "boolean" || !Array.isArray(input.limits) ||
      input.limits.length === 0 || input.limits.length > 4) return result(["invalid-requirements"]);
  const units = new Set<ResourceUnit>();
  for (const limit of input.limits) {
    if (!plain(limit) || Object.keys(limit).length !== 2 || !Object.hasOwn(limit, "unit") ||
        !Object.hasOwn(limit, "maximum") || !isResourceUnit(limit.unit) ||
        !positiveSafeInteger(limit.maximum) || units.has(limit.unit)) return result(["invalid-requirements"]);
    units.add(limit.unit);
  }
  const adapter = inventory.find(entry => entry.engine === input.engine);
  if (!adapter) return result(["unknown-engine"]);
  if (adapter.implementation !== "implemented") return result(["adapter-not-implemented"]);
  const reasons: string[] = [];
  if (!adapter.actions.includes(input.action)) reasons.push("unsupported-action");
  if (input.requireProviderVerification) reasons.push("provider-verification-missing");
  for (const unit of units) {
    if (!adapter.queryHardLimits.includes(unit)) reasons.push(`unsupported-query-hard-limit:${unit}`);
  }
  return result(reasons);
}
