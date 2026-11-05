import type { ControlAccess } from "./control-storage";

export type AdmissionIntent = {
  id: string;
  contractId: string;
  budgetId: string;
  reservationId: string;
  actionDigest: string;
  reservedUnits: number;
};

type StoredIntent = {
  id: string; contract_id: string; budget_id: string; reservation_id: string;
  action_digest: string; reserved_units: number; principal_id: string;
};

// Internal primitive. The execution service must supply a trusted cost upper bound
// and revalidate semantic eligibility, policy, agent identity and target first.
export async function admitExecutionIntent(access: ControlAccess, intent: AdmissionIntent) {
  if (![intent.id, intent.contractId, intent.budgetId, intent.reservationId, intent.actionDigest].every(
    value => typeof value === "string" && value.trim().length > 0
  ) || !Number.isSafeInteger(intent.reservedUnits) || intent.reservedUnits < 0) throw new Error("Invalid execution intent");
  const existing = await access.db.prepare(`SELECT i.* FROM execution_intents i WHERE i.tenant_id=? AND i.id=?
    AND i.principal_id=? AND EXISTS(SELECT 1 FROM control_memberships m WHERE m.tenant_id=i.tenant_id AND m.principal_id=? AND m.active=1 AND m.role IN ('reader','reviewer','owner'))`)
    .bind(access.tenantId, intent.id, access.principalId, access.principalId).first<StoredIntent>();
  if (existing) {
    if (existing.contract_id !== intent.contractId || existing.budget_id !== intent.budgetId ||
      existing.reservation_id !== intent.reservationId || existing.action_digest !== intent.actionDigest ||
      existing.reserved_units !== intent.reservedUnits) throw new Error("Idempotency conflict");
    return { id: existing.id, replay: true };
  }
  // The trigger reserves budget, consumes authority, appends the lifecycle event
  // and inserts the intent in one SQLite transaction; any failure rolls back all.
  const result = await access.db.prepare(`INSERT INTO execution_intents
    (tenant_id,id,contract_id,budget_id,reservation_id,principal_id,action_digest,reserved_units) VALUES (?,?,?,?,?,?,?,?)`)
    .bind(access.tenantId, intent.id, intent.contractId, intent.budgetId, intent.reservationId,
      access.principalId, intent.actionDigest, intent.reservedUnits).run();
  if (!result.success) throw new Error("Execution admission failed");
  return { id: intent.id, replay: false };
}
