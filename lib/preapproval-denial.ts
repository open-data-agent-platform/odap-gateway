import { isEvidenceReceipt } from "./control-objects";
import type { ControlAccess } from "./control-storage";
import { bindMetricRead, type MetricRead } from "./dispatch-authority";

// Internal negative decision only. Access and agent identity must already be
// authenticated; attemptId is an opaque, server-assigned tenant correlation ID.
export async function recordMissingReleaseDenial(access: ControlAccess, attemptId: string,
  agentId: string, requestedRelease: string, action: MetricRead) {
  if (![attemptId, agentId, requestedRelease].every(v => typeof v === "string" && /^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,127}$/.test(v))) {
    throw new Error("Invalid pre-approval identifiers");
  }
  const { db, tenantId, principalId } = access;
  const { actionDigest } = await bindMetricRead(action);
  const receiptId = "denied_preapproval_" + attemptId;
  const write = await db.prepare(`INSERT INTO missing_release_denials
    (tenant_id,attempt_id,principal_id,agent_id,requested_release,action_digest,receipt_id) VALUES(?,?,?,?,?,?,?)`)
    .bind(tenantId, attemptId, principalId, agentId, requestedRelease, actionDigest, receiptId).run();
  if (!write.success) throw new Error("Pre-approval denial write failed");
  const row = await db.prepare(`SELECT r.payload FROM missing_release_denials d
    JOIN evidence_receipts r ON r.tenant_id=d.tenant_id AND r.id=d.receipt_id AND r.created_by=d.principal_id
    JOIN control_memberships m ON m.tenant_id=d.tenant_id AND m.principal_id=d.principal_id AND m.active=1
    WHERE d.tenant_id=? AND d.attempt_id=? AND d.principal_id=? AND d.agent_id=?
      AND d.requested_release=? AND d.action_digest=?`)
    .bind(tenantId, attemptId, principalId, agentId, requestedRelease, actionDigest).first<{ payload: string }>();
  if (!row) throw new Error("Pre-approval denial unavailable");
  const receipt: unknown = JSON.parse(row.payload);
  if (!isEvidenceReceipt(receipt) || receipt.id !== receiptId || receipt.tenantId !== tenantId ||
      receipt.intentId !== attemptId || receipt.outcome !== "denied" ||
      receipt.contractId !== null || receipt.semanticReleaseId !== null) throw new Error("Invalid denial receipt");
  return receipt;
}
