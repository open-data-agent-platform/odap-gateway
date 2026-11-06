import type { ControlAccess } from "./control-storage";
import { proposalHistory } from "./request-inspection";
import { eligibleMetricRelease as eligible, prepareMetricPreview } from "./metric-preview";

export type ContractRequestInput = { requestId: string; releaseId: string; requestedAgentId: string; action: unknown };
export { InvalidRequestedAction } from "./metric-preview";

export async function readOwnProposal({ db, tenantId, principalId }: ControlAccess, id: string, includeGrant = false) {
  // Historical intake survives retirement. Current membership, not release eligibility, gates this read.
  const row = await db.prepare(`SELECT q.tenant_id AS tenantId,q.id,'proposed' AS recordedState,q.release_id AS releaseId,
    q.requested_agent_id AS requestedAgentId,q.action_digest AS actionDigest,q.requested_at AS requestedAt
    ${includeGrant ? ",g.id AS grantId,g.granted_at AS grantedAt,g.expires_at AS expiresAt" : ""}
    FROM contract_requests q JOIN control_memberships m ON m.tenant_id=q.tenant_id AND m.principal_id=q.principal_id
    ${includeGrant ? "LEFT JOIN contract_human_grants g ON g.tenant_id=q.tenant_id AND g.requester_id=q.principal_id AND g.request_id=q.id" : ""}
    WHERE q.tenant_id=? AND q.principal_id=? AND q.id=? AND m.active=1 AND m.role IN ('reader','reviewer','owner')`)
    .bind(tenantId, principalId, id).first<Record<string, unknown>>();
  if (!row) return null;
  if (includeGrant) {
    const { grantId, grantedAt, expiresAt } = row;
    row.grantReference = grantId === null && grantedAt === null && expiresAt === null ? null : { grantId, grantedAt, expiresAt };
  }
  const snapshot = proposalHistory(row, tenantId, id);
  if (!snapshot) throw new Error("Invalid stored proposal");
  return snapshot;
}

export async function requestMetricContract(access: ControlAccess, input: ContractRequestInput) {
  const { db, tenantId, principalId } = access;
  const scope = [tenantId, input.releaseId, principalId];
  const preview = await prepareMetricPreview(access, input.releaseId, input.action);
  if (!preview) return null;
  const { actionDigest } = preview;
  const args = [input.requestId, input.requestedAgentId, actionDigest];
  const inserted = await db.prepare(`INSERT INTO contract_requests
    (tenant_id,principal_id,id,requested_agent_id,action_digest,release_id)
    SELECT e.tenant_id,m.principal_id,?,?,?,e.release_id ${eligible} RETURNING requested_at AS requestedAt`)
    .bind(...args, ...scope).first<{ requestedAt: string }>();
  // A retry may acknowledge only this principal's identical request, and
  // only while the release and membership are still eligible.
  const stored = inserted ?? await db.prepare(`SELECT q.requested_at AS requestedAt FROM contract_requests q
    WHERE q.tenant_id=? AND q.principal_id=? AND q.release_id=? AND q.id=? AND q.requested_agent_id=? AND q.action_digest=?
    AND EXISTS (SELECT 1 ${eligible})`)
    .bind(tenantId, principalId, input.releaseId, ...args, ...scope).first<{ requestedAt: string }>();
  if (!stored) return null;
  return { replay: !inserted, request: { requestId: input.requestId, releaseId: input.releaseId,
    requestedAgentId: input.requestedAgentId, actionDigest, requestedAt: stored.requestedAt, state: "proposed" as const } };
}
