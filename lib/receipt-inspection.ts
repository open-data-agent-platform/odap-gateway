import { inspectObject } from "./object-inspection";
import { isControlTimestamp } from "./control-objects";
import { isReceiptCorrectionInput } from "./receipt-correction-input";
import { isReceiptId } from "./receipt-id";
import { intentJobId } from "./bigquery-job-identity";
import { isReceiptSummary, type ReceiptSummary } from "./receipt-summary";

export function inspectEvidenceReceipt(tenant: string, id: string, signal: AbortSignal, get: typeof fetch = fetch) {
  return inspectObject(tenant, id, "receipt", signal, get, value =>
    isReceiptSummary(value) && value.tenantId === tenant && value.id === id ? value : null);
}

export type Explanation = { tenantId: string; id: string; issuedReason: string; latest: { revision: number; correctedReason: string } | null };

export function inspectReceiptExplanation(tenant: string, id: string, signal: AbortSignal, get: typeof fetch = fetch) {
  return inspectObject<Explanation>(tenant, id, "receipt-explanations", signal, get, value => {
    if (!value || typeof value !== "object") return null;
    const v = value as Record<string, unknown>;
    if (Object.keys(v).length !== 4 || v.tenantId !== tenant || v.id !== id ||
        typeof v.issuedReason !== "string" || !v.issuedReason.trim()) return null;
    const base = { tenantId: tenant, id, issuedReason: v.issuedReason };
    if (v.latest === null) return { ...base, latest: null };
    if (!v.latest || typeof v.latest !== "object") return null;
    const c = v.latest as Record<string, unknown>;
    if (Object.keys(c).length !== 2 || typeof c.revision !== "number" || !Number.isSafeInteger(c.revision) || c.revision < 1 ||
        typeof c.correctedReason !== "string" || c.correctedReason.length > 512 || !c.correctedReason.trim()) return null;
    return { ...base, latest: { revision: c.revision, correctedReason: c.correctedReason } };
  });
}

type HistoricalCorrection = { revision: number; correctedReason: string; evidenceRef: string; actor: string; recordedAt: string };
type RevisionRead = { state: "historical"; record: HistoricalCorrection } |
  { state: "revision_unavailable" | "unauthenticated" | "denied" | "unavailable" };

function matchingCorrection(value: unknown, tenantId: string, id: string, revision: number): HistoricalCorrection | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const c = value as Record<string, unknown>;
  const input = { expectedRevision: revision - 1, correctedReason: c.correctedReason, evidenceRef: c.evidenceRef };
  if (Object.keys(c).length !== 7 || c.tenantId !== tenantId || c.receiptId !== id || c.revision !== revision ||
      !isReceiptCorrectionInput(input) || typeof c.actor !== "string" || !c.actor.trim() ||
      typeof c.recordedAt !== "string" || !isControlTimestamp(c.recordedAt)) return null;
  return { revision, correctedReason: input.correctedReason, evidenceRef: input.evidenceRef, actor: c.actor, recordedAt: c.recordedAt };
}

const correctionsPath = (tenantId: string, id: string) => "/api/control/" + tenantId + "/receipt-corrections/" + encodeURIComponent(id);

export async function inspectReceiptRevision(tenantId: string, id: string, revision: number, signal: AbortSignal,
  get: typeof fetch = fetch): Promise<RevisionRead> {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(tenantId) || !isReceiptId(id) || !Number.isSafeInteger(revision) || revision < 1)
    return { state: "revision_unavailable" };
  try {
    const res = await get(correctionsPath(tenantId,id) + "?revision=" + revision, {
      method: "GET", credentials: "same-origin", mode: "same-origin", cache: "no-store", redirect: "error", signal
    });
    const body = await res.json();
    if (body?.ok === false) {
      if (res.status === 401 && body.code === "unauthenticated") return { state: "unauthenticated" };
      if (res.status === 403 && ["receipt_correction_denied","tenant_access_denied"].includes(body.code)) return { state: "denied" };
      if (res.status === 404 && body.code === "receipt_correction_unavailable") return { state: "revision_unavailable" };
    }
    const record = res.status === 200 && body?.ok === true && matchingCorrection(body.correction,tenantId,id,revision);
    if (record) return { state: "historical", record };
  } catch { /* A failed lookup cannot establish whether the write took place. */ }
  return { state: "unavailable" };
}

type CorrectionResult = { state: "recorded"; revision: number } | { state: "uncertain"; attemptedRevision: number } |
  { state: "invalid_correction" | "conflict" | "denied" | "unauthenticated" | "not_found" };

export async function submitReceiptCorrection(inspected: Explanation, correctedReason: string, evidenceRef: string,
  signal: AbortSignal, post: typeof fetch = fetch): Promise<CorrectionResult> {
  const { tenantId, id, latest } = inspected;
  const expectedRevision = latest === null ? 0 : latest.revision;
  const input = { expectedRevision, correctedReason, evidenceRef };
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(tenantId) || !isReceiptId(id) || !isReceiptCorrectionInput(input))
    return { state: "invalid_correction" };
  try {
    const res = await post(correctionsPath(tenantId,id), {
      method: "POST", credentials: "same-origin", mode: "same-origin", cache: "no-store", redirect: "error", signal,
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(input)
    });
    const body = await res.json();
    const c = res.status === 200 && body?.ok === true && matchingCorrection(body.correction,tenantId,id,expectedRevision + 1);
    if (c && c.correctedReason === correctedReason && c.evidenceRef === evidenceRef)
      return { state: "recorded", revision: c.revision };
    if (body?.ok === false) {
      if (res.status === 409 && body.code === "receipt_correction_conflict") return { state: "conflict" };
      if (res.status === 400 && body.code === "invalid_receipt_correction") return { state: "invalid_correction" };
      if (res.status === 401 && body.code === "unauthenticated") return { state: "unauthenticated" };
      if (res.status === 403 && ["receipt_correction_denied","tenant_access_denied"].includes(body.code)) return { state: "denied" };
      if (res.status === 404 && body.code === "receipt_correction_unavailable") return { state: "not_found" };
    }
  } catch { /* A lost acknowledgment does not mean the append failed. */ }
  return { state: "uncertain", attemptedRevision: expectedRevision + 1 };
}

export type IntentReceiptScope = { tenantId: string; intentId: string; contractId: string; delegationId: string; actionDigest: string };

export async function inspectOwnIntentReceipt({ tenantId, intentId, contractId, delegationId, actionDigest }: IntentReceiptScope,
  signal: AbortSignal, get: typeof fetch = fetch) {
  const result = await inspectObject<{ receipt: ReceiptSummary | null }>(tenantId, intentId, "intent-receipt", signal, get, value => {
    if (!value || typeof value !== "object") return null;
    const row = value as Record<string, unknown>;
    if (row.tenantId !== tenantId || row.intentId !== intentId || row.contractId !== contractId ||
        row.delegationId !== delegationId || row.actionDigest !== actionDigest) return null;
    const receipt = row.receipt;
    if (receipt === null) return { receipt: null };
    return isReceiptSummary(receipt) && receipt.tenantId === tenantId && receipt.outcome !== "denied" ? { receipt } : null;
  });
  if (result.state !== "ready" || !result.snapshot.receipt) return result;
  const receipt = result.snapshot.receipt;
  try {
    const prefix = receipt.outcome === "pending" ? "pending_" : "final_";
    if (receipt.id === prefix + await intentJobId(tenantId, intentId)) return result;
  } catch { /* An unverifiable reference must not reach the UI. */ }
  return { state: "unavailable" } as const;
}
