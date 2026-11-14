import { createHash } from "node:crypto";
import { verifySettledEvidence } from "./settled-evidence";

const release = "https://raw.githubusercontent.com/open-data-agent-platform/odap-gateway/openlineage-evidence-v0.1.0";
export const openLineageSchema = "https://openlineage.io/spec/2-0-2/OpenLineage.json";
export const odapEvidenceSchema = `${release}/integrations/openlineage/OdapEvidenceRunFacet.json`;
const producer = `${release}/integrations/openlineage/README.md`;

type Scope = { tenantId: string; intentId: string; audience?: string };
type ValidatedBundle = {
  profile: string;
  contract: { id: string; target: string };
  release: { id: string };
  job: { projectId: string; location: string; jobId: string; claimedAt: string };
  observation: { observedAt: string };
};

function deploymentNamespace(value: string) {
  if (typeof value !== "string" || value.length > 512 || /[\s\x00-\x1f\x7f]/.test(value))
    throw new Error("Invalid OpenLineage namespace");
  const url = new URL(value);
  if (!["https:", "urn:"].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
      value.includes("?") || value.includes("#") || !url.pathname)
    throw new Error("Invalid OpenLineage namespace");
  return url.href;
}

// UUIDv5, URL namespace (RFC 9562). This is stable correlation, not authentication.
function runId(name: string) {
  const bytes = createHash("sha1")
    .update(Buffer.from("6ba7b8119dad11d180b400c04fd430c8", "hex")).update(name, "utf8").digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Reconstruct a Gateway attempt cycle from pinned evidence; never sends events. */
export async function exportOpenLineage(json: string, scope: Scope, expectedDigest: string, namespace: string) {
  if (typeof expectedDigest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(expectedDigest)) throw new Error("Invalid pin");
  const report = await verifySettledEvidence(json, scope, expectedDigest);
  // The verifier has checked the exact record shapes, cross-links and chronology.
  const data = JSON.parse(json) as ValidatedBundle;
  const deployment = deploymentNamespace(namespace);
  const id = runId(JSON.stringify(["odap.gateway.bigquery-attempt.v1", deployment, scope.tenantId,
    data.job.projectId, data.job.location, data.job.jobId]));
  const job = { namespace: deployment,
    name: `odap/tenant/${encodeURIComponent(scope.tenantId)}/target/${encodeURIComponent(data.contract.target)}` };
  const common = { producer, schemaURL: `${openLineageSchema}#/$defs/RunEvent`, job };
  const eventType = report.outcome === "succeeded" ? "COMPLETE" : report.outcome === "failed" ? "FAIL" : "ABORT";
  const facet = {
    _producer: producer, _schemaURL: `${odapEvidenceSchema}#/$defs/OdapEvidenceRunFacet`,
    profile: data.profile, evidenceDigest: report.digest, receiptId: report.receiptId,
    contractId: data.contract.id, semanticReleaseId: data.release.id, intentId: scope.intentId,
    recordedOutcome: report.outcome, consistencyChecked: true, issuerAuthenticated: false,
    retrospective: true, startTimeBasis: "gateway-claim", endTimeBasis: "gateway-terminal-observation"
  };
  // No dataset edges: the source bundle does not establish physical table lineage.
  return [
    { ...common, eventType: "START", eventTime: data.job.claimedAt, run: { runId: id } },
    { ...common, eventType, eventTime: data.observation.observedAt, run: { runId: id, facets: { odap_evidence: facet } } }
  ];
}
