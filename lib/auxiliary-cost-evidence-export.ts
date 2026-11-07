import type { ControlAccess } from "./control-storage";
import { canonicalControlJson } from "./control-objects";
import { auxiliaryCostMaxBytes, auxiliaryCostMaxComponents, auxiliaryCostProfile, auxiliaryCostScope, verifyAuxiliaryCostEvidence } from "./auxiliary-cost-evidence";

function audit(kind: "reserved" | "settled") {
  return `(SELECT json_group_array(json(event)) FROM (SELECT json_object(
    'sequence',e.sequence,'tenantId',e.tenant_id,'objectId',e.object_id,'kind',e.object_kind,
    'actor',e.actor,'recordedAt',e.recorded_at) AS event FROM control_object_events e
    WHERE e.tenant_id=r.tenant_id AND e.object_id=r.id AND e.object_kind='auxiliary_cost_${kind}'
    ORDER BY e.sequence LIMIT 2))`;
}

// One owner-scoped SELECT: no billing calls, writes, pagination or caller-selected component subset.
export async function exportAuxiliaryCostEvidence(access: ControlAccess, intentId: string) {
  if (typeof intentId !== "string" || !intentId.trim() || intentId.length > 1024) throw new Error("Invalid intent ID");
  const row = await access.db.prepare(`SELECT json_object('profile',?,'scope',?,
    'intent',json_object('tenantId',i.tenant_id,'intentId',i.id,'contractId',i.contract_id,'budgetId',i.budget_id,
      'principalId',i.principal_id,'reservationId',i.reservation_id,'actionDigest',i.action_digest),
    'components',json((SELECT json_group_array(json(component)) FROM (
      SELECT json_object('id',r.id,'kind',r.kind,'operationRef',r.operation_ref,'operationDigest',r.operation_digest,
        'upperBoundMicroUsd',r.reserved_units,'reservedBy',r.actor,'reservedAt',r.recorded_at,
        'reservationEvents',json(${audit("reserved")}),
        'settlement',CASE WHEN s.reservation_id IS NULL THEN NULL ELSE json_object('operationRef',s.operation_ref,
          'billingRef',s.billing_ref,'actualMicroUsd',s.actual_units,'actor',s.actor,'recordedAt',s.recorded_at) END,
        'settlementEvents',json(${audit("settled")})) AS component
      FROM auxiliary_cost_reservations r LEFT JOIN auxiliary_cost_settlements s
        ON s.tenant_id=r.tenant_id AND s.reservation_id=r.id
      WHERE r.tenant_id=i.tenant_id AND r.intent_id=i.id ORDER BY r.id COLLATE BINARY LIMIT ${auxiliaryCostMaxComponents + 1}
    ))) ) AS evidence FROM execution_intents i JOIN control_memberships m ON m.tenant_id=i.tenant_id
    WHERE i.tenant_id=? AND i.id=? AND m.principal_id=? AND m.active=1 AND m.role='owner'`)
    .bind(auxiliaryCostProfile,auxiliaryCostScope,access.tenantId,intentId,access.principalId).first<{ evidence: string }>();
  if (!row) return null;
  if (typeof row.evidence !== "string" || row.evidence.length > auxiliaryCostMaxBytes) throw new Error("Invalid auxiliary evidence size");
  const json = canonicalControlJson(JSON.parse(row.evidence));
  const report = await verifyAuxiliaryCostEvidence(json, {tenantId:access.tenantId,intentId});
  return { json, digest: report.digest };
}
