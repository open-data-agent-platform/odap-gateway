// Draft v0.1 object contracts. Callers must load authoritative state server-side.
export type ObjectHeader = {
  schemaVersion: "0.1";
  id: string;
  tenantId: string;
};

export type SemanticRelease = ObjectHeader & {
  definitionDigest: string;
  sourceRevision: string;
  owner: string;
  state: "released" | "deprecated" | "revoked";
};

export type ApprovalContract = ObjectHeader & {
  semanticReleaseId: string;
  principalId: string;
  agentId: string;
  actionDigest: string;
  policyRevision: string;
  sourceRevision: string;
  target: string;
  actionType: "data.read";
  authority: { mode: "human" | "policy"; reference: string };
  reservationId: string;
  expiresAt: string;
  state: "authorized" | "consumed" | "revoked";
};

export type EvidenceReceipt = ObjectHeader & {
  intentId: string;
  contractId: string | null;
  semanticReleaseId: string | null;
  outcome: "denied" | "pending" | "succeeded" | "failed" | "cancelled";
  reason: string;
  recordedAt: string;
};

export type ExecutionContext = {
  tenantId: string;
  principalId: string;
  agentId: string;
  actionDigest: string;
  policyRevision: string;
  sourceRevision: string;
  target: string;
  reservationId: string;
  now: number;
  permissionGranted: boolean;
  reservationActive: boolean;
};

function headerValid(value: ObjectHeader) {
  return value.schemaVersion === "0.1" && Boolean(value.id?.trim()) && Boolean(value.tenantId?.trim());
}

export function evaluateExecutionContract(
  release: SemanticRelease,
  contract: ApprovalContract,
  context: ExecutionContext
): { allowed: boolean; reason: string } {
  const deny = (reason: string) => ({ allowed: false, reason });
  if (!headerValid(release) || !headerValid(contract)) return deny("invalid_object_header");
  if (!context.tenantId || release.tenantId !== context.tenantId || contract.tenantId !== context.tenantId) return deny("tenant_mismatch");
  if (release.state !== "released" || contract.semanticReleaseId !== release.id || !release.definitionDigest) return deny("ineligible_semantic_release");
  if (contract.state !== "authorized") return deny("contract_not_authorized");
  const expiry = Date.parse(contract.expiresAt);
  if (!Number.isFinite(context.now) || !Number.isFinite(expiry) || expiry <= context.now) return deny("expired_contract");
  if (contract.actionType !== "data.read") return deny("unsupported_action");
  if (!contract.authority?.reference?.trim() || !["human", "policy"].includes(contract.authority.mode)) return deny("missing_authority");
  const fields = ["principalId", "agentId", "actionDigest", "policyRevision", "sourceRevision", "target", "reservationId"] as const;
  for (const field of fields) {
    if (!context[field]?.trim() || context[field] !== contract[field]) return deny(`${field}_mismatch`);
  }
  if (release.sourceRevision !== context.sourceRevision) return deny("semantic_source_drift");
  if (context.permissionGranted !== true) return deny("permission_denied");
  if (context.reservationActive !== true) return deny("reservation_inactive");
  return { allowed: true, reason: "eligible" };
}

export function validateEvidenceReceipt(receipt: EvidenceReceipt) {
  if (!headerValid(receipt) || !receipt.intentId?.trim() || !receipt.reason?.trim() ||
      !Number.isFinite(Date.parse(receipt.recordedAt))) return false;
  if (!["denied", "pending", "succeeded", "failed", "cancelled"].includes(receipt.outcome)) return false;
  // Denied requests may never have acquired authority or a semantic release.
  return receipt.outcome === "denied" || Boolean(receipt.contractId?.trim() && receipt.semanticReleaseId?.trim());
}

// Local canonical JSON profile, not an interoperable signing standard.
// Restrict values to JSON and safe integers; reject undefined and exotic objects.
export function canonicalControlJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) throw new Error("Use safe integers or decimal strings");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${Array.from(value, canonicalControlJson).join(",")}]`;
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalControlJson(record[key])}`).join(",")}}`;
  }
  throw new Error("Unsupported canonical value");
}
