import { readPreparedJob } from "./bigquery-job-storage";
import { readTerminalObservation } from "./bigquery-terminal-observations";
import { isEvidenceReceipt } from "./control-objects";
import type { ControlAccess } from "./control-storage";
import { validCharge, type BillingKey } from "./job-charge";
import { terminalOutcomesConflict } from "./terminal-outcome-sql";

type Saved = { conflict: number; reference: string | null; amount: number | null; receiptId: string | null; payload: string | null };

async function readSettlement(access: ControlAccess, intentId: string) {
  const row = await access.db.prepare(`SELECT ${terminalOutcomesConflict("i")} AS conflict,e.evidence_ref AS reference,s.actual_units AS amount,
      s.receipt_id AS receiptId,r.payload FROM execution_intents i
    LEFT JOIN cost_settlements s ON s.tenant_id=i.tenant_id AND s.intent_id=i.id
    LEFT JOIN evidence_receipts r ON r.tenant_id=s.tenant_id AND r.id=s.receipt_id
    LEFT JOIN bigquery_billing_evidence e ON e.tenant_id=s.tenant_id AND e.intent_id=s.intent_id
      AND e.receipt_id=s.receipt_id AND e.actual_micro_usd=s.actual_units
    JOIN control_memberships m ON m.tenant_id=i.tenant_id
    WHERE i.tenant_id=? AND i.id=? AND m.principal_id=? AND m.role='owner' AND m.active=1`)
    .bind(access.tenantId, intentId, access.principalId).first<Saved>();
  if (!row) throw new Error("Job settlement unavailable");
  if (row.conflict) throw new Error("Conflicting terminal outcomes");
  if (row.receiptId === null) return null;
  const receipt: unknown = row.payload && JSON.parse(row.payload);
  if (row.amount === null || !row.reference || !isEvidenceReceipt(receipt) || receipt.id !== row.receiptId ||
      receipt.intentId !== intentId || receipt.tenantId !== access.tenantId ||
      !["succeeded", "failed", "cancelled"].includes(receipt.outcome)) throw new Error("Unverified job settlement");
  return { state: "settled" as const, reference: row.reference, actualMicroUsd: row.amount, receipt };
}

// Internal adapter dependency, never an HTTP request body. Null means no final
// attributable monetary evidence. No default provider, pricing or network path.
export async function reconcileBigQueryBill(access: ControlAccess, intentId: string,
  loadFinalCharge: (key: BillingKey) => Promise<unknown>) {
  const { identity } = await readPreparedJob(access, intentId);
  const terminal = await readTerminalObservation(access, intentId);
  if (!terminal) return await readSettlement(access, intentId) ?? { state: "pending-terminal" as const };
  const key = { tenantId: access.tenantId, jobReference: identity.jobReference };
  const bill = await loadFinalCharge({ ...key, jobReference: { ...key.jobReference } });
  if (bill === null) return await readSettlement(access, intentId) ?? { state: "pending-bill" as const };
  if (!validCharge(bill, key)) throw new Error("Invalid final job charge");
  const { reference, amount } = bill;
  const result = await access.db.prepare(`INSERT INTO bigquery_billing_evidence
    (tenant_id,intent_id,receipt_id,evidence_ref,actual_micro_usd,actor)
    SELECT i.tenant_id,i.id,?,?,?,? FROM execution_intents i
    WHERE i.tenant_id=? AND i.id=? AND NOT ${terminalOutcomesConflict("i")} AND NOT EXISTS (
      SELECT 1 FROM bigquery_billing_evidence b WHERE b.tenant_id=i.tenant_id AND b.intent_id=i.id)`)
    .bind("final_" + key.jobReference.jobId, reference, amount,
      access.principalId, access.tenantId, intentId).run();
  if (!result.success) throw new Error("Billing evidence write failed");
  const saved = await readSettlement(access, intentId);
  if (!saved) throw new Error("Job settlement unavailable");
  if (saved.reference !== reference || saved.actualMicroUsd !== amount) throw new Error("Billing evidence conflict");
  return saved;
}
