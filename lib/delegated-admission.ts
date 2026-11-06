import type { ControlAccess } from "./control-storage";
import { budgetQuote } from "./requester-budget-admission";
import { admissionHistory } from "./admission-history";

export async function readOwnAdmission({ db, tenantId, principalId }: ControlAccess, audience: string, contractId: string) {
  // Read the immutable intent, not the current budget counters or today's eligible quote.
  const row = await db.prepare(`SELECT a.tenant_id AS tenantId,a.contract_id AS contractId,i.delegation_id AS delegationId,
    e.id AS intentId,e.action_digest AS actionDigest,e.budget_id AS budgetId,e.reserved_units AS originalMicroUsd
    FROM delegated_admissions a JOIN delegated_contract_issuances i USING(tenant_id,contract_id,requested_by,audience)
    JOIN execution_intents e ON e.tenant_id=a.tenant_id AND e.id=a.intent_id AND e.contract_id=a.contract_id
      AND e.principal_id=a.requested_by AND e.reservation_id=i.reservation_id
    JOIN control_memberships m ON m.tenant_id=a.tenant_id AND m.principal_id=a.requested_by
    WHERE a.tenant_id=? AND a.contract_id=? AND a.audience=? AND a.requested_by=?
      AND m.active=1 AND m.role IN ('reader','reviewer','owner')`).bind(tenantId, contractId, audience, principalId).first();
  if (!row) return null;
  const record = admissionHistory(row, tenantId, contractId);
  if (!record) throw new Error("Invalid stored admission");
  return record;
}

export async function readBudgetQuote(access: ControlAccess, audience: string, contractId: string) {
  const row = await access.db.prepare(`SELECT a.tenant_id AS tenantId,a.contract_id AS contractId,i.delegation_id AS delegationId,
    a.budget_id AS budgetId,a.per_read_micro_usd AS microUsd,a.action_digest AS actionDigest,json_extract(c.payload,'$.expiresAt') AS expiresAt
    FROM admissible_delegated_contracts a JOIN delegated_contract_issuances i USING(tenant_id,contract_id)
    JOIN approval_contracts c ON c.tenant_id=a.tenant_id AND c.id=a.contract_id
    WHERE a.tenant_id=? AND a.contract_id=? AND a.audience=? AND a.requested_by=?`)
    .bind(access.tenantId, contractId, audience, access.principalId).first();
  if (!row) return null;
  const q = budgetQuote(row, access.tenantId, contractId);
  if (!q) throw new Error("Invalid stored budget quote");
  return q;
}

export async function admitDelegatedContract(access: ControlAccess, audience: string, contractId: string) {
  const scope = [access.tenantId, contractId, audience, access.principalId];
  const created = await access.db.prepare(`INSERT INTO delegated_admissions
    (tenant_id,contract_id,intent_id,audience,requested_by)
    SELECT tenant_id,contract_id,?,audience,requested_by FROM admissible_delegated_contracts
    WHERE tenant_id=? AND contract_id=? AND audience=? AND requested_by=?
    RETURNING intent_id AS intentId`).bind(crypto.randomUUID(), ...scope).first<{ intentId: string }>();
  if (created) return { intentId: created.intentId, replay: false };

  // Capacity may now be exhausted by this very reservation. Replay only the
  // historical acknowledgement, never reserve again or authorize dispatch.
  const prior = await access.db.prepare(`SELECT a.intent_id AS intentId FROM delegated_admissions a
    JOIN delegated_contract_issuances i ON i.tenant_id=a.tenant_id AND i.contract_id=a.contract_id
    JOIN issuable_delegations d ON d.tenant_id=i.tenant_id AND d.delegation_id=i.delegation_id
      AND d.audience=a.audience AND d.requester_id=a.requested_by
    WHERE a.tenant_id=? AND a.contract_id=? AND a.audience=? AND a.requested_by=?`)
    .bind(...scope).first<{ intentId: string }>();
  return prior && { intentId: prior.intentId, replay: true };
}
