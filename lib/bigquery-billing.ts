import { readPreparedJob } from "./bigquery-job-storage";
import { readTerminalObservation } from "./bigquery-terminal-observations";
import { isEvidenceReceipt } from "./control-objects";
import type { ControlAccess } from "./control-storage";

type JobRef = { projectId: string; location: string; jobId: string };
type BillingKey = { tenantId: string; jobReference: JobRef };
type FinalCharge = BillingKey & { status: "final"; unit: "micro-USD"; reference: string; amount: number };
type Saved = { reference: string | null; amount: number; receiptId: string; payload: string };

function validCharge(value: unknown, key: BillingKey): value is FinalCharge {
  if (!value || typeof value !== "object") return false;
  const bill = value as Partial<FinalCharge>;
  return bill.status === "final" && bill.unit === "micro-USD" && bill.tenantId === key.tenantId &&
    bill.jobReference?.projectId === key.jobReference.projectId && bill.jobReference.location === key.jobReference.location &&
    bill.jobReference.jobId === key.jobReference.jobId && typeof bill.reference === "string" &&
    /^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,127}$/.test(bill.reference) &&
    typeof bill.amount === "number" && Number.isSafeInteger(bill.amount) && bill.amount >= 0;
}

async function readSettlement(access: ControlAccess, intentId: string) {
  const row = await access.db.prepare(`SELECT e.evidence_ref AS reference,s.actual_units AS amount,
      s.receipt_id AS receiptId,r.payload FROM cost_settlements s
    JOIN evidence_receipts r ON r.tenant_id=s.tenant_id AND r.id=s.receipt_id
    LEFT JOIN bigquery_billing_evidence e ON e.tenant_id=s.tenant_id AND e.intent_id=s.intent_id
      AND e.receipt_id=s.receipt_id AND e.actual_micro_usd=s.actual_units
    JOIN control_memberships m ON m.tenant_id=s.tenant_id
    WHERE s.tenant_id=? AND s.intent_id=? AND m.principal_id=? AND m.role='owner' AND m.active=1`)
    .bind(access.tenantId, intentId, access.principalId).first<Saved>();
  if (!row) return null;
  const receipt: unknown = JSON.parse(row.payload);
  if (!row.reference || !isEvidenceReceipt(receipt) || receipt.id !== row.receiptId ||
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
    SELECT ?,?,?,?,?,? WHERE NOT EXISTS (
      SELECT 1 FROM bigquery_billing_evidence WHERE tenant_id=? AND intent_id=?)`)
    .bind(access.tenantId, intentId, "final_" + key.jobReference.jobId, reference, amount,
      access.principalId, access.tenantId, intentId).run();
  if (!result.success) throw new Error("Billing evidence write failed");
  const saved = await readSettlement(access, intentId);
  if (!saved) throw new Error("Job settlement unavailable");
  if (saved.reference !== reference || saved.actualMicroUsd !== amount) throw new Error("Billing evidence conflict");
  return saved;
}
