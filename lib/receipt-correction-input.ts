type CorrectionInput = { expectedRevision: number; correctedReason: string; evidenceRef: string };

export function isReceiptCorrectionInput(value: unknown): value is CorrectionInput {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const v = value as Record<string,unknown>;
  return Object.keys(v).length === 3 && ["expectedRevision","correctedReason","evidenceRef"].every(k => Object.hasOwn(v,k)) &&
    typeof v.expectedRevision === "number" && Number.isSafeInteger(v.expectedRevision) &&
    v.expectedRevision >= 0 && v.expectedRevision < Number.MAX_SAFE_INTEGER &&
    typeof v.correctedReason === "string" && v.correctedReason.length <= 512 && !!v.correctedReason.trim() &&
    !v.correctedReason.includes("\0") && typeof v.evidenceRef === "string" &&
    v.evidenceRef.length > 0 && v.evidenceRef.length <= 160 && !/[^a-zA-Z0-9:._-]/.test(v.evidenceRef);
}
