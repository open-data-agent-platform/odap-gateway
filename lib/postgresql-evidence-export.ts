import type { ControlAccess } from "./control-storage";
import { canonicalControlJson } from "./control-objects";
import { routeId } from "./control-command-request";
import { postgresEvidenceMaxBytes, postgresEvidenceProfile, verifyPostgresEvidence } from "./postgresql-evidence";

// A single snapshot, restricted to the source's named, currently active owner.
// It is independent of provider access and remains useful after source retirement.
export async function exportPostgresEvidence(access: ControlAccess, requestId: string) {
  if (typeof requestId !== "string" || !routeId.test(requestId)) throw new Error("PostgreSQL evidence unavailable");
  const row = await access.db.prepare(`SELECT c.intent_id,json_object(
    'profile',?,'tenantId',q.tenant_id,'requestId',q.id,'intentId',c.intent_id,'monetaryCost','unpriced',
    'release',json(r.payload),'contract',json(a.payload),'definition',json(v.definition_json),'action',json(q.action_json),
    'source',json_object('id',s.id,'target',s.target,'ownerId',s.owner_id,'connectionDigest',s.connection_digest,
      'roleName',s.role_name,'relation',json(s.source_json)),
    'claim',json_object('principalId',c.claimed_by,'budgetId',c.budget_id,'statementDigest',c.statement_digest,'claimedAt',c.claimed_at),
    'observation',CASE WHEN o.intent_id IS NULL THEN NULL ELSE json_object('outcome',o.outcome,'recordedAt',o.observed_at) END,
    'failure',CASE WHEN f.intent_id IS NULL THEN NULL ELSE json_object('sqlState',f.sql_state,'statementDigest',f.statement_digest,'recordedAt',f.recorded_at) END,
    'cancellation',CASE WHEN k.intent_id IS NULL THEN NULL ELSE json_object('requestedBy',k.requested_by,'recordedAt',k.requested_at) END,
    'receipts',json((SELECT json_group_array(json(e.payload)) FROM evidence_receipts e
      WHERE e.tenant_id=q.tenant_id AND e.id IN ('pg-pending-'||c.intent_id,'pg-observed-'||c.intent_id,
        'pg-failed-'||c.intent_id,'pg-cancel-'||c.intent_id)
      AND (SELECT CASE WHEN count(*)=1 THEN max(x.actor=e.created_by AND x.recorded_at=e.created_at) ELSE 0 END
        FROM control_object_events x WHERE x.tenant_id=e.tenant_id AND x.object_kind='receipt' AND x.object_id=e.id)))
    ) AS evidence
    FROM postgresql_read_requests q JOIN postgresql_source_versions s ON s.tenant_id=q.tenant_id AND s.id=q.source_id
    JOIN control_memberships m ON m.tenant_id=s.tenant_id AND m.principal_id=s.owner_id AND m.active=1 AND m.role='owner'
    JOIN semantic_releases r ON r.tenant_id=q.tenant_id AND r.id=q.release_id
    JOIN semantic_release_promotions p ON p.tenant_id=r.tenant_id AND p.release_id=r.id
    JOIN semantic_candidate_revisions v ON v.tenant_id=p.tenant_id AND v.id=p.revision_id
    JOIN postgresql_read_approvals approved ON approved.tenant_id=q.tenant_id AND approved.request_id=q.id
    JOIN approval_contracts a ON a.tenant_id=approved.tenant_id AND a.id=approved.contract_id
    JOIN postgresql_read_claims c ON c.tenant_id=q.tenant_id AND c.request_id=q.id
    LEFT JOIN postgresql_read_observations o ON o.tenant_id=c.tenant_id AND o.request_id=c.request_id AND o.intent_id=c.intent_id
    LEFT JOIN postgresql_terminal_failures f ON f.tenant_id=c.tenant_id AND f.request_id=c.request_id AND f.intent_id=c.intent_id
    LEFT JOIN postgresql_cancellation_requests k ON k.tenant_id=c.tenant_id AND k.request_id=c.request_id AND k.intent_id=c.intent_id
    WHERE q.tenant_id=? AND q.id=? AND m.principal_id=?`)
    .bind(postgresEvidenceProfile, access.tenantId, requestId, access.principalId).first<{ intent_id: string; evidence: string }>();
  if (!row) throw new Error("PostgreSQL evidence unavailable");
  if (typeof row.evidence !== "string" || row.evidence.length > postgresEvidenceMaxBytes ||
      new TextEncoder().encode(row.evidence).length > postgresEvidenceMaxBytes) throw new Error("PostgreSQL evidence unavailable");
  const data = JSON.parse(row.evidence);
  data.receipts.sort((a: { id: string }, b: { id: string }) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const json = canonicalControlJson(data);
  const verified = await verifyPostgresEvidence(json, { tenantId: access.tenantId, requestId, intentId: row.intent_id });
  return { json, digest: verified.digest };
}
