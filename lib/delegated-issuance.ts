import type { ControlAccess } from "./control-storage";
import { issuanceReference } from "./issuance-history";

export async function readOwnIssuance({ tenantId, principalId, db }: ControlAccess, audience: string, delegationId: string) {
  // Use the immutable issuance, not the view that admits new commands.
  const row = await db.prepare(`SELECT i.tenant_id AS tenantId,i.delegation_id AS delegationId,i.contract_id AS contractId,
    d.grant_id AS grantId,g.request_id AS requestId FROM delegated_contract_issuances i
    JOIN agent_delegations d ON d.tenant_id=i.tenant_id AND d.id=i.delegation_id AND d.audience=i.audience
    JOIN contract_human_grants g ON g.tenant_id=d.tenant_id AND g.id=d.grant_id AND g.requester_id=i.requested_by
    JOIN control_memberships m ON m.tenant_id=i.tenant_id AND m.principal_id=i.requested_by
    WHERE i.tenant_id=? AND i.delegation_id=? AND i.audience=? AND i.requested_by=?
      AND m.active=1 AND m.role IN ('reader','reviewer','owner')`).bind(tenantId, delegationId, audience, principalId).first();
  if (!row) return null;
  const ref = issuanceReference(row, tenantId, delegationId);
  if (!ref) throw new Error("Invalid stored issuance reference");
  return ref;
}

export async function issueDelegatedContract(access: ControlAccess, audience: string, delegationId: string) {
  const scope = [access.tenantId, audience, delegationId, access.principalId];
  const eligible = "d.tenant_id=? AND d.audience=? AND d.delegation_id=? AND d.requester_id=?";
  const created = await access.db.prepare(`INSERT INTO delegated_contract_issuances
    (tenant_id,delegation_id,audience,requested_by,contract_id,reservation_id)
    SELECT d.tenant_id,d.delegation_id,d.audience,d.requester_id,?,? FROM issuable_delegations d
    WHERE ${eligible} AND NOT EXISTS (SELECT 1 FROM delegated_contract_issuances i
      WHERE i.tenant_id=d.tenant_id AND i.delegation_id=d.delegation_id)
    RETURNING contract_id AS contractId`).bind(crypto.randomUUID(), crypto.randomUUID(), ...scope).first<{ contractId: string }>();
  if (created) return { contractId: created.contractId, replay: false };

  const prior = await access.db.prepare(`SELECT i.contract_id AS contractId FROM issuable_delegations d
    JOIN delegated_contract_issuances i ON i.tenant_id=d.tenant_id AND i.delegation_id=d.delegation_id
    JOIN contract_lifecycle l ON l.tenant_id=i.tenant_id AND l.contract_id=i.contract_id
    WHERE ${eligible} AND l.state='authorized'`).bind(...scope).first<{ contractId: string }>();
  return prior && { contractId: prior.contractId, replay: true };
}
