import { isControlTimestamp, type EvidenceReceipt } from "./control-objects";

export type ReceiptSummary = Pick<EvidenceReceipt, "tenantId" | "id" | "outcome" | "recordedAt"> & {
  hasContract: boolean; hasSemanticRelease: boolean;
};

// Only this projection crosses the wire for an inspection. Reasons and
// reference values are arbitrary strings in the original receipt.
export function summarizeReceipt(receipt: EvidenceReceipt): ReceiptSummary {
  return {
    tenantId: receipt.tenantId, id: receipt.id, outcome: receipt.outcome, recordedAt: receipt.recordedAt,
    hasContract: receipt.contractId !== null, hasSemanticRelease: receipt.semanticReleaseId !== null
  };
}

export const outcomeLabels = {
  pending: "Pending", denied: "Denied", succeeded: "Succeeded", failed: "Failed", cancelled: "Cancelled"
} satisfies Record<EvidenceReceipt["outcome"], string>;

export function isReceiptSummary(value: unknown): value is ReceiptSummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return Object.keys(v).every(k => ["tenantId","id","outcome","recordedAt","hasContract","hasSemanticRelease"].includes(k)) &&
    typeof v.tenantId === "string" && typeof v.id === "string" && isControlTimestamp(v.recordedAt) &&
    typeof v.outcome === "string" && Object.prototype.hasOwnProperty.call(outcomeLabels, v.outcome) &&
    typeof v.hasContract === "boolean" && typeof v.hasSemanticRelease === "boolean" &&
    (v.outcome === "denied" || (v.hasContract && v.hasSemanticRelease));
}
