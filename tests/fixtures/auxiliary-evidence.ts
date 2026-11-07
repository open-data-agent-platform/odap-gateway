import { auxiliaryCostProfile, auxiliaryCostScope } from "../../lib/auxiliary-cost-evidence";

export function auxiliaryEvidence() {
  const at = "2026-11-07T00:00:00.000Z";
  return { profile: auxiliaryCostProfile, scope: auxiliaryCostScope,
    intent: {tenantId:"t",intentId:"i",contractId:"c",budgetId:"b",principalId:"user",reservationId:"s",actionDigest:"sha256:"+"b".repeat(64)},
    components: [{id:"model-1",kind:"model",operationRef:"fixture:model",operationDigest:"sha256:"+"a".repeat(64),
      upperBoundMicroUsd:30,reservedBy:"owner",reservedAt:at,
      reservationEvents:[{sequence:1,tenantId:"t",objectId:"model-1",kind:"auxiliary_cost_reserved",actor:"owner",recordedAt:at}],
      settlement:{operationRef:"fixture:model",billingRef:"fixture:bill",actualMicroUsd:12,actor:"owner",recordedAt:at},
      settlementEvents:[{sequence:2,tenantId:"t",objectId:"model-1",kind:"auxiliary_cost_settled",actor:"owner",recordedAt:at}]
    }] };
}
