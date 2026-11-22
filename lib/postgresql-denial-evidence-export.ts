import type { ControlAccess } from "./control-storage";
import { canonicalControlJson } from "./control-objects";
import { postgresDenialAttempt, postgresDenialEvidenceMaxBytes, postgresDenialEvidenceProfile,
  verifyPostgresDenialEvidence } from "./postgresql-denial-evidence";

// There is no source owner for a missing release. Only a current tenant owner
// may export this historical denial; the original actor need not remain active.
export async function exportPostgresDenialEvidence(access: ControlAccess, attemptId: string) {
  if (typeof attemptId !== "string" || !postgresDenialAttempt.test(attemptId)) throw new Error("PostgreSQL denial evidence unavailable");
  const row = await access.db.prepare(`SELECT json_object(
    'profile',?,'tenantId',d.tenant_id,'attemptId',d.attempt_id,
    'denial',json_object('principalId',d.principal_id,'agentId',d.agent_id,'requestedRelease',d.requested_release,
      'actionDigest',d.action_digest,'recordedAt',d.recorded_at),
    'receipt',json(r.payload),'receiptCreatedAt',r.created_at,
    'creationEvent',json_object('actor',e.actor,'recordedAt',e.recorded_at)) AS evidence
    FROM missing_release_denials d
    JOIN control_memberships m ON m.tenant_id=d.tenant_id AND m.principal_id=? AND m.active=1 AND m.role='owner'
    JOIN evidence_receipts r ON r.tenant_id=d.tenant_id AND r.id=d.receipt_id AND r.created_by=d.principal_id
      AND r.contract_id IS NULL AND r.release_id IS NULL
    JOIN control_object_events e ON e.tenant_id=r.tenant_id AND e.object_kind='receipt' AND e.object_id=r.id
      AND e.actor=r.created_by AND e.recorded_at=r.created_at
    WHERE d.tenant_id=? AND d.attempt_id=? AND d.agent_id='postgresql-session'
      AND (SELECT count(*) FROM control_object_events x WHERE x.tenant_id=r.tenant_id
        AND x.object_kind='receipt' AND x.object_id=r.id)=1
      AND NOT EXISTS(SELECT 1 FROM execution_intents i WHERE i.tenant_id=d.tenant_id AND i.id=d.attempt_id)`)
    .bind(postgresDenialEvidenceProfile, access.principalId, access.tenantId, attemptId).first<{ evidence: string }>();
  if (!row || typeof row.evidence !== "string" || row.evidence.length > postgresDenialEvidenceMaxBytes ||
      new TextEncoder().encode(row.evidence).length > postgresDenialEvidenceMaxBytes) throw new Error("PostgreSQL denial evidence unavailable");
  const json = canonicalControlJson(JSON.parse(row.evidence));
  const verified = await verifyPostgresDenialEvidence(json, { tenantId: access.tenantId, attemptId });
  return { json, digest: verified.digest };
}
