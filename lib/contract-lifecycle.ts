import type { ControlAccess } from "./control-storage";
import { isApprovalContract } from "./control-objects";

export async function readEffectiveContract(access: ControlAccess, id: string) {
  const row = await access.db.prepare(`SELECT c.payload, l.state FROM approval_contracts c
    JOIN contract_lifecycle l ON l.tenant_id = c.tenant_id AND l.contract_id = c.id
    WHERE c.tenant_id = ? AND c.id = ? AND EXISTS
    (SELECT 1 FROM control_memberships m WHERE m.tenant_id = c.tenant_id AND m.principal_id = ? AND m.active = 1 AND m.role IN ('reader','reviewer','owner'))`)
    .bind(access.tenantId, id, access.principalId).first<{ payload: string; state: string }>();
  if (!row) return null;
  const value: unknown = JSON.parse(row.payload);
  if (!isApprovalContract(value) || value.tenantId !== access.tenantId || value.id !== id ||
      !["authorized", "consumed", "revoked"].includes(row.state)) throw new Error("Invalid stored contract");
  return { ...value, state: row.state as "authorized" | "consumed" | "revoked" };
}

export async function revokeContract(access: ControlAccess, id: string, reason: string) {
  if (!reason.trim()) throw new Error("Revocation reason required");
  const result = await access.db.prepare(`UPDATE contract_lifecycle SET state = 'revoked', changed_by = ?, reason = ?
    WHERE tenant_id = ? AND contract_id = ? AND state = 'authorized' AND EXISTS
    (SELECT 1 FROM control_memberships WHERE tenant_id = ? AND principal_id = ? AND active = 1 AND role = 'owner')`)
    .bind(access.principalId, reason.trim(), access.tenantId, id, access.tenantId, access.principalId).run();
  return result.success === true && result.meta?.changes === 1;
}

// Internal single-use claim only; not a complete execution authorization service.
// The caller must separately verify action, agent, policy, release, and budget.
export async function consumeContract(access: ControlAccess, id: string) {
  const result = await access.db.prepare(`UPDATE contract_lifecycle SET state = 'consumed', changed_by = ?, reason = 'single-use claim'
    WHERE tenant_id = ? AND contract_id = ? AND state = 'authorized'
    AND EXISTS (SELECT 1 FROM control_memberships WHERE tenant_id = ? AND principal_id = ? AND active = 1 AND role IN ('reader','reviewer','owner'))
    AND EXISTS (SELECT 1 FROM approval_contracts c WHERE c.tenant_id = ? AND c.id = ?
      AND json_extract(c.payload,'$.principalId') = ? AND json_extract(c.payload,'$.state') = 'authorized'
      AND julianday(json_extract(c.payload,'$.expiresAt')) > julianday('now'))`)
    .bind(access.principalId, access.tenantId, id, access.tenantId, access.principalId, access.tenantId, id, access.principalId).run();
  return result.success === true && result.meta?.changes === 1;
}
