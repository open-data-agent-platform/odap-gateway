import { isEvidenceReceipt } from "./control-objects";
import type { ControlAccess } from "./control-storage";
import { loadDelegatedClaimSnapshot } from "./delegated-job-recovery";
import { attributedCharge, validCharge, type BillingKey } from "./job-charge";
import { terminalOutcomesConflict } from "./terminal-outcome-sql";

const pinned = `j.tenant_id=? AND j.intent_id=? AND j.audience=? AND j.operator_id=? AND j.compiled_body_digest=?
  AND j.project_id=? AND j.location=? AND j.job_id=? AND j.receipt_id=? AND j.cap=?`;

async function billingContext({ db,tenantId,principalId }: ControlAccess, audience: string, intentId: string) {
  const { row,identity } = await loadDelegatedClaimSnapshot(db,[tenantId,intentId,audience,principalId]);
  return { db, intentId, key: { tenantId,jobReference: identity.jobReference },
    args: [tenantId,intentId,audience,principalId,row.compiled_body_digest,row.project_id,row.location,row.job_id,row.receipt_id,row.cap] };
}

async function readState({ db,intentId,key,args }: Awaited<ReturnType<typeof billingContext>>) {
  const row = await db.prepare(`SELECT j.terminal_outcome,j.contract_id,j.release_id,b.intent_id AS bill,s.intent_id AS settlement,
    b.evidence_ref,b.actual_micro_usd,f.payload,${terminalOutcomesConflict("j")} AS conflict,
    (b.delegation_audience=j.audience AND b.claim_body_digest=j.compiled_body_digest AND b.attributed_project=j.project_id
      AND b.attributed_location=j.location AND b.receipt_id='final_'||j.job_id AND s.receipt_id=b.receipt_id
      AND s.actual_units=b.actual_micro_usd AND s.actor=b.actor AND f.created_by=b.actor AND f.contract_id=j.contract_id
      AND f.release_id=j.release_id AND json_extract(f.payload,'$.recordedAt')=b.recorded_at) AS verified
    FROM delegated_billing_jobs j LEFT JOIN bigquery_billing_evidence b ON b.tenant_id=j.tenant_id AND b.intent_id=j.intent_id
    LEFT JOIN cost_settlements s ON s.tenant_id=j.tenant_id AND s.intent_id=j.intent_id
    LEFT JOIN evidence_receipts f ON f.tenant_id=j.tenant_id AND f.id=s.receipt_id WHERE ${pinned}`).bind(...args)
    .first<{ conflict: number; terminal_outcome: string | null; contract_id: string; release_id: string; bill: string | null;
      settlement: string | null; verified: number | null; evidence_ref: string; actual_micro_usd: number; payload: string | null }>();
  if (!row) throw new Error("Delegated billing scope unavailable");
  if (row.conflict) throw new Error("Conflicting terminal outcomes");
  if (row.bill === null && row.settlement === null) return row.terminal_outcome === null
    ? { state: "pending-terminal" as const } : { state: "pending-bill" as const };
  const receipt: unknown = row.payload && JSON.parse(row.payload);
  if (row.verified !== 1 || !isEvidenceReceipt(receipt) || receipt.intentId !== intentId || receipt.tenantId !== key.tenantId ||
      receipt.id !== "final_"+key.jobReference.jobId || receipt.contractId !== row.contract_id ||
      receipt.semanticReleaseId !== row.release_id || receipt.outcome !== row.terminal_outcome)
    throw new Error("Unverified delegated settlement");
  return { state: "settled" as const, reference: row.evidence_ref, actualMicroUsd: row.actual_micro_usd, receipt };
}

export async function readDelegatedBilling(access: ControlAccess, audience: string, intentId: string) {
  return readState(await billingContext(access,audience,intentId));
}

// Internal, with an explicitly supplied source. Never turn metered bytes or a
// provisional invoice into a monetary amount.
export async function reconcileDelegatedBill(access: ControlAccess, audience: string, intentId: string,
  loadCharge: (key: BillingKey) => Promise<unknown>) {
  if (typeof loadCharge !== "function") throw new Error("Explicit billing source required");
  const ctx = await billingContext(access,audience,intentId);
  const initial = await readState(ctx);
  if (initial.state === "pending-terminal") return initial;
  const { key } = ctx;
  const bill = await loadCharge({ tenantId:key.tenantId, jobReference:{ ...key.jobReference } });
  if (bill === null || (attributedCharge(bill,key) &&
      (bill.status === "provisional" || bill.status === "pending" || bill.status === "estimated"))) return readState(ctx);
  if (!validCharge(bill,key)) throw new Error("Invalid final delegated charge");
  const { reference,amount } = bill;
  const write = await ctx.db.prepare(`INSERT INTO bigquery_billing_evidence
    (tenant_id,intent_id,receipt_id,evidence_ref,actual_micro_usd,actor,delegation_audience,claim_body_digest,attributed_project,attributed_location)
    SELECT j.tenant_id,j.intent_id,'final_'||j.job_id,?,?,j.operator_id,j.audience,j.compiled_body_digest,j.project_id,j.location
    FROM delegated_billing_jobs j WHERE ${pinned} AND j.terminal_outcome IS NOT NULL
      AND NOT ${terminalOutcomesConflict("j")}
      AND NOT EXISTS(SELECT 1 FROM bigquery_billing_evidence b WHERE b.tenant_id=j.tenant_id AND b.intent_id=j.intent_id)`)
    .bind(reference,amount,...ctx.args).run();
  if (!write.success) throw new Error("Delegated billing write not confirmed");
  const saved = await readState(ctx);
  if (saved.state !== "settled") throw new Error("Delegated settlement not confirmed");
  if (saved.reference !== reference || saved.actualMicroUsd !== amount) throw new Error("Delegated billing evidence conflict");
  return saved;
}
