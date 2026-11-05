import type { ControlAccess } from "./control-storage";
import { canonicalControlJson, isEvidenceReceipt } from "./control-objects";

// Internal reconciler only: actualUnits must come from authoritative billing/job
// evidence, not a caller's estimate. Owner membership is checked in database SQL.
export async function settleIntentCost(access: ControlAccess, receipt: unknown, actualUnits: number | null) {
  if (!isEvidenceReceipt(receipt) || receipt.tenantId !== access.tenantId ||
      !["succeeded", "failed", "cancelled"].includes(receipt.outcome)) throw new Error("Final execution receipt required");
  if (actualUnits === null) return { settled: false, pending: true };
  if (!Number.isSafeInteger(actualUnits) || actualUnits < 0) throw new Error("Invalid actual cost");
  if (!access.db.batch) throw new Error("Transactional storage required");
  const existing = await access.db.prepare(`SELECT s.actual_units,s.receipt_id,r.payload FROM cost_settlements s
    JOIN evidence_receipts r ON r.tenant_id=s.tenant_id AND r.id=s.receipt_id
    WHERE s.tenant_id=? AND s.intent_id=? AND EXISTS(SELECT 1 FROM control_memberships WHERE tenant_id=? AND principal_id=? AND active=1 AND role='owner')`)
    .bind(access.tenantId, receipt.intentId, access.tenantId, access.principalId)
    .first<{ actual_units: number; receipt_id: string; payload: string }>();
  const payload = canonicalControlJson(receipt);
  if (existing) {
    if (existing.actual_units !== actualUnits || existing.receipt_id !== receipt.id || existing.payload !== payload) throw new Error("Settlement conflict");
    return { settled: true, replay: true };
  }
  const results = await access.db.batch([
    access.db.prepare(`INSERT INTO evidence_receipts(tenant_id,id,release_id,contract_id,payload,created_by) VALUES(?,?,?,?,?,?)`)
      .bind(access.tenantId, receipt.id, receipt.semanticReleaseId, receipt.contractId, payload, access.principalId),
    access.db.prepare(`INSERT INTO cost_settlements(tenant_id,intent_id,receipt_id,actual_units,actor) VALUES(?,?,?,?,?)`)
      .bind(access.tenantId, receipt.intentId, receipt.id, actualUnits, access.principalId)
  ]);
  if (results.some(result => !result.success)) throw new Error("Settlement failed");
  return { settled: true, replay: false };
}
