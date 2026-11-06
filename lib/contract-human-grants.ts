import { canonicalControlJson, sha256Text } from "./control-objects";
import type { ControlAccess } from "./control-storage";

export type HumanGrantReview = {
  requesterId: string; requestId: string; releaseId: string; requestedAgentId: string;
  policyRevision: string; reviewedAction: unknown;
};
export type HumanGrantInput = HumanGrantReview & { grantId: string };
export class InvalidGrantAction extends Error {}

const eligible = `FROM grantable_contract_requests e WHERE e.tenant_id=? AND e.owner_id=? AND e.requester_id=?
  AND e.request_id=? AND e.release_id=? AND e.requested_agent_id=? AND e.policy_revision=? AND e.action_digest=?`;
type GrantTime = { grantedAt: string; expiresAt: string };

async function reviewedScope(access: ControlAccess, input: HumanGrantReview) {
  // Re-hash what the owner reviewed; never accept a digest in lieu of the action.
  let action: string;
  try { action = canonicalControlJson(input.reviewedAction); }
  catch { throw new InvalidGrantAction(); }
  const actionDigest = await sha256Text(action);
  const scope = [access.tenantId, access.principalId, input.requesterId, input.requestId, input.releaseId,
    input.requestedAgentId, input.policyRevision, actionDigest];
  return { scope, actionDigest };
}

export async function reviewHumanGrant(access: ControlAccess, input: HumanGrantReview) {
  const { scope } = await reviewedScope(access, input);
  return access.db.prepare(`SELECT e.tenant_id AS tenantId,e.owner_id AS reviewedBy,e.requester_id AS requesterId,e.request_id AS requestId,
    e.release_id AS releaseId,e.requested_agent_id AS requestedAgentId,e.policy_revision AS policyRevision,
    e.action_digest AS actionDigest ${eligible}`).bind(...scope).first();
}

export async function recordHumanGrant(access: ControlAccess, input: HumanGrantInput) {
  const { scope, actionDigest } = await reviewedScope(access, input);
  const created = await access.db.prepare(`INSERT INTO contract_human_grants
    (tenant_id,id,requester_id,request_id,granted_by,policy_revision,project_id,location)
    SELECT e.tenant_id,?,e.requester_id,e.request_id,e.owner_id,e.policy_revision,e.project_id,e.location ${eligible}
    RETURNING granted_at AS grantedAt,expires_at AS expiresAt`).bind(input.grantId, ...scope).first<GrantTime>();
  const prior = created ?? await access.db.prepare(`SELECT g.granted_at AS grantedAt,g.expires_at AS expiresAt FROM contract_human_grants g
    WHERE g.tenant_id=? AND g.id=? AND julianday(g.expires_at)>julianday('now') AND EXISTS (SELECT 1 ${eligible}
      AND e.tenant_id=g.tenant_id AND e.requester_id=g.requester_id AND e.request_id=g.request_id AND e.owner_id=g.granted_by
      AND e.policy_revision=g.policy_revision AND e.project_id=g.project_id AND e.location=g.location)`)
    .bind(access.tenantId, input.grantId, ...scope).first<GrantTime>();
  if (!prior) return null;
  return { replay: !created, grant: { tenantId: access.tenantId, grantId: input.grantId, requesterId: input.requesterId, requestId: input.requestId,
    releaseId: input.releaseId, requestedAgentId: input.requestedAgentId, policyRevision: input.policyRevision,
    grantedBy: access.principalId, actionDigest, ...prior } };
}
