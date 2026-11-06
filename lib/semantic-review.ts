import type { ControlAccess } from "./control-storage";
import { canonicalControlJson, sha256Text } from "./control-objects";

type ReviewSnapshot = {
  tenantId: string; revisionId: string; metricId: string; definitionDigest: string; sourceRevision: string;
  canRecordValidation: boolean; canReviewApproval: boolean; canRequestPromotion: boolean; canRetireRelease: boolean;
  state: "candidate" | "validated" | "approved" | "withdrawn" | "published" | "retired";
  approvalId: string | null; releaseId: string | null;
  validatedAt: string | null; approvedAt: string | null; withdrawnAt: string | null;
  publishedAt: string | null; retiredAt: string | null;
};
type ActionHints = "canRecordValidation" | "canReviewApproval" | "canRequestPromotion" | "canRetireRelease";

// One snapshot for the UI; even "published" is not a dispatch authorization.
export async function readSemanticReview(access: ControlAccess, revisionId: string) {
  const row = await access.db.prepare(`SELECT r.tenant_id AS tenantId,r.id AS revisionId,
    (m.role='owner' AND m.principal_id=r.owner_id AND v.revision_id IS NULL) AS canRecordValidation,
    (m.role='owner' AND m.principal_id=r.owner_id AND v.validated_by=m.principal_id AND
      v.definition_digest=r.definition_digest AND a.id IS NULL) AS canReviewApproval,
    (m.role='owner' AND m.principal_id=r.owner_id AND a.approved_by=m.principal_id) AS canRequestPromotion,
    (m.role='owner' AND m.principal_id=json_extract(s.payload,'$.owner') AND json_extract(s.payload,'$.state')='released') AS canRetireRelease,
    json_extract(r.definition_json,'$.metricId') AS metricId,r.definition_digest AS definitionDigest,
    json_extract(r.definition_json,'$.sourceRevision') AS sourceRevision,
    CASE WHEN d.release_id IS NOT NULL THEN 'retired' WHEN p.release_id IS NOT NULL THEN 'published'
      WHEN w.approval_id IS NOT NULL THEN 'withdrawn' WHEN a.id IS NOT NULL THEN 'approved'
      WHEN v.revision_id IS NOT NULL THEN 'validated' ELSE 'candidate' END AS state,
    a.id AS approvalId,p.release_id AS releaseId,v.validated_at AS validatedAt,a.approved_at AS approvedAt,
    w.withdrawn_at AS withdrawnAt,s.created_at AS publishedAt,d.retired_at AS retiredAt
    FROM semantic_candidate_revisions r JOIN control_memberships m ON m.tenant_id=r.tenant_id
    LEFT JOIN semantic_candidate_validations v ON v.tenant_id=r.tenant_id AND v.revision_id=r.id
    LEFT JOIN semantic_candidate_approvals a ON a.tenant_id=r.tenant_id AND a.revision_id=r.id
    LEFT JOIN semantic_approval_withdrawals w ON w.tenant_id=a.tenant_id AND w.approval_id=a.id
    LEFT JOIN semantic_release_promotions p ON p.tenant_id=a.tenant_id AND p.approval_id=a.id
    LEFT JOIN semantic_releases s ON s.tenant_id=p.tenant_id AND s.id=p.release_id
    LEFT JOIN dispatch_retired_releases d ON d.tenant_id=p.tenant_id AND d.release_id=p.release_id
    WHERE r.tenant_id=? AND r.id=? AND m.principal_id=? AND m.active=1 AND m.role IN ('reviewer','owner')`)
    .bind(access.tenantId, revisionId, access.principalId)
    .first<Omit<ReviewSnapshot, ActionHints> & Record<ActionHints, number | null>>();
  const ownsPendingApproval = row?.canRequestPromotion === 1 && row.state === "approved";
  return row && { ...row, canRecordValidation: row.canRecordValidation === 1 && row.state === "candidate",
    canReviewApproval: row.canReviewApproval === 1 && row.state === "validated",
    canRetireRelease: row.canRetireRelease === 1 && row.state === "published",
    canRequestPromotion: ownsPendingApproval, canWithdrawApproval: ownsPendingApproval };
}

// Private decision input, never part of the shared review summary.
export function readApprovalBasis(access: ControlAccess, revisionId: string) {
  return access.db.prepare(`SELECT r.tenant_id AS tenantId,r.id AS revisionId,r.definition_digest AS definitionDigest,
    v.evidence_ref AS evidenceRef FROM semantic_candidate_revisions r
    JOIN semantic_candidate_validations v ON v.tenant_id=r.tenant_id AND v.revision_id=r.id
      AND v.definition_digest=r.definition_digest AND v.validated_by=r.owner_id
    JOIN control_memberships m ON m.tenant_id=r.tenant_id AND m.principal_id=r.owner_id AND m.role='owner' AND m.active=1
    WHERE r.tenant_id=? AND r.id=? AND m.principal_id=? AND NOT EXISTS (
      SELECT 1 FROM semantic_candidate_approvals a WHERE a.tenant_id=r.tenant_id AND a.revision_id=r.id)`)
    .bind(access.tenantId, revisionId, access.principalId)
    .first<{ tenantId: string; revisionId: string; definitionDigest: string; evidenceRef: string }>();
}

export async function readReviewDefinition(access: ControlAccess, revisionId: string) {
  const row = await access.db.prepare(`SELECT r.tenant_id AS tenantId,r.id AS revisionId,
    r.definition_json AS definitionJson,r.definition_digest AS definitionDigest
    FROM semantic_candidate_revisions r JOIN control_memberships m ON m.tenant_id=r.tenant_id
    WHERE r.tenant_id=? AND r.id=? AND m.principal_id=? AND m.active=1 AND m.role IN ('reviewer','owner')`)
    .bind(access.tenantId, revisionId, access.principalId)
    .first<{ tenantId: string; revisionId: string; definitionJson: string; definitionDigest: string }>();
  if (!row) return null;
  // The reviewer hashes the stored text, not a parse/stringify round trip.
  const value = JSON.parse(row.definitionJson);
  if (value?.profile !== "odap.bigquery-metric.v1" || value.tenantId !== access.tenantId ||
      canonicalControlJson(value) !== row.definitionJson || await sha256Text(row.definitionJson) !== row.definitionDigest) {
    throw new Error("Stored review definition is inconsistent");
  }
  return row;
}
