import { canonicalControlJson, sha256Text } from "./control-objects";
import type { ControlAccess } from "./control-storage";
import { readReviewDefinition } from "./semantic-review";

function label(value: unknown, max = 256): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && value.trim() === value;
}

export class InvalidSemanticRevision extends Error {}
export class SemanticProposalNotRecorded extends Error {}
export class InvalidSemanticValidation extends Error {}
export class SemanticValidationNotRecorded extends Error {}
export class InvalidSemanticApproval extends Error {}
export class SemanticApprovalNotRecorded extends Error {}
export class InvalidSemanticWithdrawal extends Error {}
export class SemanticWithdrawalUnavailable extends Error {}
export class InvalidSemanticRetirement extends Error {}
export class SemanticRetirementUnavailable extends Error {}

// A proposal is not a validated metric and never grants execution.
export async function proposeSemanticRevision(access: ControlAccess, input: {
  revisionId: string; ownerId: string; provenanceRef: string; definitionJson: string;
}) {
  if (!label(input.revisionId) || !label(input.ownerId) || !label(input.provenanceRef, 1024) ||
      typeof input.definitionJson !== "string" || input.definitionJson.length > 32_768) {
    throw new InvalidSemanticRevision("Invalid semantic revision");
  }
  let canonical: string;
  try {
    const d = JSON.parse(input.definitionJson);
    if (d?.profile !== "odap.bigquery-metric.v1" || d.tenantId !== access.tenantId ||
        !label(d.sourceRevision) || !label(d.target) || !label(d.metricId)) throw new Error();
    canonical = canonicalControlJson(d);
  } catch {
    throw new InvalidSemanticRevision("Invalid semantic revision content or scope");
  }
  const digest = await sha256Text(canonical);
  const result = await access.db.prepare(`INSERT INTO semantic_candidate_revisions
    (tenant_id,id,definition_json,definition_digest,owner_id,provenance_ref,proposed_by)
    SELECT proposer.tenant_id,?,?,?,?,?,proposer.principal_id FROM control_memberships proposer
    JOIN control_memberships owner ON owner.tenant_id=proposer.tenant_id AND owner.principal_id=?
    WHERE proposer.tenant_id=? AND proposer.principal_id=? AND proposer.active=1 AND proposer.role IN ('owner','reviewer')
      AND owner.active=1 AND owner.role='owner'`)
    .bind(input.revisionId, canonical, digest, input.ownerId, input.provenanceRef,
      input.ownerId, access.tenantId, access.principalId).run();
  if (!result.success || typeof result.meta?.changes !== "number") throw new Error("Semantic storage unavailable");
  if (result.meta.changes !== 1) throw new SemanticProposalNotRecorded("Semantic proposal not recorded");
  return { revisionId: input.revisionId, definitionDigest: digest };
}

// The digest is what the reviewer actually saw, not a digest supplied at proposal time.
export async function recordSemanticValidation(access: ControlAccess, revisionId: string, reviewedDigest: string,
  evidenceRef: string) {
  if (!label(revisionId) || typeof reviewedDigest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(reviewedDigest) ||
      !label(evidenceRef, 1024)) throw new InvalidSemanticValidation("Invalid semantic validation");
  const revision = await readReviewDefinition(access, revisionId);
  if (revision?.definitionDigest !== reviewedDigest) throw new SemanticValidationNotRecorded("Semantic validation not recorded");
  const result = await access.db.prepare(`INSERT INTO semantic_candidate_validations
    (tenant_id,revision_id,definition_digest,validated_by,evidence_ref)
    SELECT r.tenant_id,r.id,r.definition_digest,m.principal_id,? FROM semantic_candidate_revisions r
    JOIN control_memberships m ON m.tenant_id=r.tenant_id AND m.principal_id=r.owner_id
    WHERE r.tenant_id=? AND r.id=? AND r.definition_digest=? AND m.principal_id=?
      AND m.role='owner' AND m.active=1`)
    .bind(evidenceRef, access.tenantId, revisionId, reviewedDigest, access.principalId).run();
  if (!result.success || typeof result.meta?.changes !== "number") throw new Error("Semantic storage unavailable");
  if (result.meta.changes !== 1) throw new SemanticValidationNotRecorded("Semantic validation not recorded");
}

// Semantic approval is not a release or a contract for query execution.
export async function approveSemanticRevision(access: ControlAccess, input: {
  approvalId: string; revisionId: string; reviewedDigest: string; evidenceRef: string;
}) {
  if (!label(input.approvalId) || !label(input.revisionId) || typeof input.reviewedDigest !== "string" ||
      !/^sha256:[0-9a-f]{64}$/.test(input.reviewedDigest) || !label(input.evidenceRef, 1024)) {
    throw new InvalidSemanticApproval("Invalid semantic approval");
  }
  const revision = await readReviewDefinition(access, input.revisionId);
  if (revision?.definitionDigest !== input.reviewedDigest) throw new SemanticApprovalNotRecorded("Semantic approval not recorded");
  const result = await access.db.prepare(`INSERT INTO semantic_candidate_approvals
    (tenant_id,id,revision_id,approved_by)
    SELECT v.tenant_id,?,v.revision_id,m.principal_id FROM semantic_candidate_validations v
    JOIN control_memberships m ON m.tenant_id=v.tenant_id AND m.principal_id=v.validated_by
    WHERE v.tenant_id=? AND v.revision_id=? AND v.definition_digest=? AND v.evidence_ref=?
      AND m.principal_id=? AND m.role='owner' AND m.active=1`)
    .bind(input.approvalId, access.tenantId, input.revisionId, input.reviewedDigest, input.evidenceRef,
      access.principalId).run();
  if (!result.success || typeof result.meta?.changes !== "number") throw new Error("Semantic storage unavailable");
  if (result.meta.changes !== 1) throw new SemanticApprovalNotRecorded("Semantic approval not recorded");
  return { approvalId: input.approvalId, revisionId: input.revisionId };
}

// Only identifiers are supplied by the caller. The database derives the release
// payload from the approved definition and checks eligibility in the same write.
export async function promoteSemanticRevision(access: ControlAccess, input: {
  releaseId: string; approvalId: string; revisionId: string;
}) {
  if (!label(input.releaseId) || !label(input.approvalId) || !label(input.revisionId)) {
    throw new Error("Invalid semantic promotion");
  }
  const result = await access.db.prepare(`INSERT INTO semantic_release_promotions
    (tenant_id,approval_id,revision_id,release_id,promoted_by) VALUES(?,?,?,?,?)
    RETURNING release_id AS releaseId`)
    .bind(access.tenantId, input.approvalId, input.revisionId, input.releaseId, access.principalId)
    .first<{ releaseId: string }>();
  if (!result) throw new Error("Semantic promotion unavailable");
  return result;
}

export async function withdrawSemanticApproval(access: ControlAccess, input: {
  approvalId: string; revisionId: string; reason: string;
}) {
  if (!label(input.approvalId) || !label(input.revisionId) || !label(input.reason, 1024)) {
    throw new InvalidSemanticWithdrawal("Invalid semantic withdrawal");
  }
  const written = await access.db.prepare(`INSERT INTO semantic_approval_withdrawals
    (tenant_id,approval_id,revision_id,withdrawn_by,reason) VALUES(?,?,?,?,?)
    RETURNING withdrawn_at AS withdrawnAt`)
    .bind(access.tenantId, input.approvalId, input.revisionId, access.principalId, input.reason)
    .first<{ withdrawnAt: string }>();
  if (written) return { status: "withdrawn" as const, withdrawnAt: written.withdrawnAt };

  // A losing contender may see the committed outcome, but only while still
  // authorized for this exact revision. Never infer withdrawal from a no-op.
  const existing = await access.db.prepare(`SELECT w.withdrawn_at AS withdrawnAt,p.release_id AS releaseId
    FROM semantic_candidate_approvals a JOIN control_memberships m
      ON m.tenant_id=a.tenant_id AND m.principal_id=a.approved_by
    LEFT JOIN semantic_approval_withdrawals w ON w.tenant_id=a.tenant_id AND w.approval_id=a.id
    LEFT JOIN semantic_release_promotions p ON p.tenant_id=a.tenant_id AND p.approval_id=a.id
    WHERE a.tenant_id=? AND a.id=? AND a.revision_id=? AND m.principal_id=? AND m.role='owner' AND m.active=1`)
    .bind(access.tenantId, input.approvalId, input.revisionId, access.principalId)
    .first<{ withdrawnAt: string | null; releaseId: string | null }>();
  if (existing?.releaseId) return { status: "already_promoted" as const, releaseId: existing.releaseId };
  if (existing?.withdrawnAt) return { status: "already_withdrawn" as const, withdrawnAt: existing.withdrawnAt };
  throw new SemanticWithdrawalUnavailable("Semantic withdrawal unavailable");
}

// Retirement blocks future dispatch claims. It is not a cancellation request or
// a statement about whether any individual job has already reached the warehouse.
export async function retireSemanticRelease(access: ControlAccess, releaseId: string, reason: string) {
  if (!label(releaseId) || !label(reason, 1024) || reason.includes("\0")) {
    throw new InvalidSemanticRetirement("Invalid semantic retirement");
  }
  const ownedRelease = `SELECT r.tenant_id, r.id, m.principal_id FROM semantic_releases r
    JOIN control_memberships m ON m.tenant_id=r.tenant_id AND m.principal_id=json_extract(r.payload,'$.owner')
    WHERE r.tenant_id=? AND r.id=? AND m.principal_id=? AND m.active=1 AND m.role='owner'
      AND json_extract(r.payload,'$.state')='released'`;
  const row = await access.db.prepare(`INSERT INTO dispatch_retired_releases
    (tenant_id,release_id,reason,retired_by,retired_at)
    SELECT tenant_id,id,?,principal_id,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM (${ownedRelease})
    RETURNING retired_at AS retiredAt`).bind(reason, access.tenantId, releaseId, access.principalId)
    .first<{ retiredAt: string }>();
  if (row) return { status: "retired" as const, retiredAt: row.retiredAt };
  const prior = await access.db.prepare(`SELECT d.retired_at AS retiredAt FROM dispatch_retired_releases d
    JOIN (${ownedRelease}) r ON r.tenant_id=d.tenant_id AND r.id=d.release_id`)
    .bind(access.tenantId, releaseId, access.principalId).first<{ retiredAt: string | null }>();
  if (!prior) throw new SemanticRetirementUnavailable("Semantic retirement unavailable");
  return prior.retiredAt === null ? { status: "legacy_retired" as const } :
    { status: "already_retired" as const, retiredAt: prior.retiredAt };
}
