import type { ControlAccess } from "./control-storage";
import { isEvidenceReceipt } from "./control-objects";
import { isReceiptCorrectionInput } from "./receipt-correction-input";

export class InvalidReceiptCorrection extends Error {}
export class ReceiptCorrectionUnavailable extends Error {}
export class ReceiptCorrectionConflict extends Error {}

// One owner-authorized snapshot. Neither source payload nor audit identifiers leave this service.
export async function readReceiptExplanation({ db, tenantId, principalId }: ControlAccess, receiptId: string) {
  const row = await db.prepare(`SELECT r.payload, c.revision, c.corrected_reason AS correctedReason
    FROM receipt_correction_targets t JOIN evidence_receipts r ON r.tenant_id=t.tenant_id AND r.id=t.receipt_id
    LEFT JOIN receipt_reason_corrections c ON c.tenant_id=t.tenant_id AND c.receipt_id=t.receipt_id
    WHERE t.tenant_id=? AND t.receipt_id=? AND t.owner_id=? ORDER BY c.revision DESC LIMIT 1`)
    .bind(tenantId,receiptId,principalId).first<{ payload: string; revision: number | null; correctedReason: string | null }>();
  if (!row) return null;
  const issued: unknown = JSON.parse(row.payload);
  if (!isEvidenceReceipt(issued) || issued.id !== receiptId || issued.tenantId !== tenantId)
    throw new Error("Invalid issued receipt");
  return { tenantId, id: receiptId, issuedReason: issued.reason, latest: row.revision === null ? null :
    { revision: row.revision, correctedReason: row.correctedReason } };
}

type Correction = { tenantId: string; receiptId: string; revision: number; correctedReason: string;
  evidenceRef: string; actor: string; recordedAt: string };

// Omit revision for the latest annotation; zero corrections is not an access denial.
export async function readReceiptReasonCorrection({db,tenantId,principalId}: ControlAccess, receiptId: string, revision?: number) {
  if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1)) throw new Error("Invalid correction revision");
  const row = await db.prepare(`SELECT t.tenant_id AS tenantId,t.receipt_id AS receiptId,c.revision,
    c.corrected_reason AS correctedReason,c.evidence_ref AS evidenceRef,c.actor,c.recorded_at AS recordedAt
    FROM receipt_correction_targets t LEFT JOIN receipt_reason_corrections c
      ON c.tenant_id=t.tenant_id AND c.receipt_id=t.receipt_id ${revision === undefined ? "" : "AND c.revision=?"}
    WHERE t.tenant_id=? AND t.receipt_id=? AND t.owner_id=? ORDER BY c.revision DESC LIMIT 1`)
    .bind(...(revision === undefined ? [] : [revision]),tenantId,receiptId,principalId)
    .first<Correction | { revision: null }>();
  if (!row) throw new ReceiptCorrectionUnavailable("Receipt correction unavailable");
  return row.revision === null ? null : row;
}

// Internal service. Identity comes from trusted ControlAccess, never from the command.
export async function appendReceiptReasonCorrection(access: ControlAccess, receiptId: string, input: unknown) {
  if (!isReceiptCorrectionInput(input)) throw new InvalidReceiptCorrection("Invalid receipt correction");
  const { expectedRevision,correctedReason,evidenceRef } = input;
  const revision = expectedRevision + 1;
  const write = await access.db.prepare(`INSERT INTO receipt_reason_corrections
    (tenant_id,receipt_id,revision,corrected_reason,evidence_ref,actor)
    SELECT t.tenant_id,t.receipt_id,?,?,?,t.owner_id FROM receipt_correction_targets t
    WHERE t.tenant_id=? AND t.receipt_id=? AND t.owner_id=? AND
      (SELECT COALESCE(MAX(c.revision),0) FROM receipt_reason_corrections c
       WHERE c.tenant_id=t.tenant_id AND c.receipt_id=t.receipt_id)=?`)
    .bind(revision,correctedReason,evidenceRef,access.tenantId,receiptId,access.principalId,expectedRevision).run();
  if (!write.success) throw new Error("Receipt correction not confirmed");
  const saved = await readReceiptReasonCorrection(access,receiptId,revision);
  if (!saved || saved.actor !== access.principalId || saved.correctedReason !== correctedReason || saved.evidenceRef !== evidenceRef) {
    if (write.meta?.changes === 0) throw new ReceiptCorrectionConflict("Receipt correction revision conflict");
    throw new Error("Receipt correction not confirmed");
  }
  return saved;
}
