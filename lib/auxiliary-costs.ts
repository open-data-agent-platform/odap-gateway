import type { ControlAccess } from "./control-storage";

export type AuxiliaryReservation = {
  id: string;
  intentId: string;
  kind: "model" | "tool";
  operationRef: string;
  operationDigest: string;
  upperBoundMicroUsd: number;
};

type StoredReservation = {
  id: string; intent_id: string; kind: "model" | "tool"; operation_ref: string;
  operation_digest: string; reserved_units: number;
  actual_units: number | null; billing_ref: string | null;
};
const ref = (value: unknown, max: number): value is string => typeof value === "string" &&
  value.length >= 1 && value.length <= max && /^[a-zA-Z0-9:._/-]+$/.test(value);
const units = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

async function stored(access: ControlAccess, id: string) {
  return access.db.prepare(`SELECT r.*,s.actual_units,s.billing_ref FROM auxiliary_cost_reservations r
    LEFT JOIN auxiliary_cost_settlements s ON s.tenant_id=r.tenant_id AND s.reservation_id=r.id
    WHERE r.tenant_id=? AND r.id=? AND EXISTS(SELECT 1 FROM control_memberships
      WHERE tenant_id=r.tenant_id AND principal_id=? AND active=1 AND role='owner')`)
    .bind(access.tenantId, id, access.principalId).first<StoredReservation>();
}

// Trusted accounting callers only. Reserving funds never authorizes provider execution.
export async function reserveAuxiliaryCost(access: ControlAccess, input: AuxiliaryReservation) {
  if (!input || !ref(input.id,128) || !ref(input.intentId,128) ||
      !["model","tool"].includes(input.kind) || !ref(input.operationRef,256) ||
      typeof input.operationDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(input.operationDigest) ||
      !units(input.upperBoundMicroUsd) || input.upperBoundMicroUsd === 0) throw new Error("Invalid auxiliary reservation");
  const prior = await stored(access,input.id);
  if (prior) {
    if (prior.intent_id !== input.intentId || prior.kind !== input.kind || prior.operation_ref !== input.operationRef ||
        prior.operation_digest !== input.operationDigest || prior.reserved_units !== input.upperBoundMicroUsd) {
      throw new Error("Auxiliary reservation conflict");
    }
    return { id: prior.id, replay: true };
  }
  const result = await access.db.prepare(`INSERT INTO auxiliary_cost_reservations
    (tenant_id,id,intent_id,kind,operation_ref,operation_digest,reserved_units,actor) VALUES(?,?,?,?,?,?,?,?) RETURNING id`)
    .bind(access.tenantId,input.id,input.intentId,input.kind,input.operationRef,input.operationDigest,
      input.upperBoundMicroUsd,access.principalId).all<{ id: string }>();
  if (!result.success || result.results?.length !== 1 || result.results[0].id !== input.id) throw new Error("Auxiliary reservation failed");
  return { id: input.id, replay: false };
}

export async function readAuxiliaryCost(access: ControlAccess, id: string) {
  if (!ref(id,128)) throw new Error("Invalid auxiliary reservation ID");
  const row = await stored(access,id);
  if (!row) throw new Error("Auxiliary cost unavailable");
  return { id: row.id, intentId: row.intent_id, kind: row.kind, operationRef: row.operation_ref,
    operationDigest: row.operation_digest, upperBoundMicroUsd: row.reserved_units,
    settled: row.actual_units !== null, actualMicroUsd: row.actual_units, billingRef: row.billing_ref };
}

// Only authoritative, final, per-operation bills qualify. Partial/unknown bills leave holds intact.
export async function settleAuxiliaryCost(access: ControlAccess, id: string, evidence: unknown) {
  if (!ref(id,128) || !evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    throw new Error("Final auxiliary bill required");
  }
  const bill = evidence as Record<string, unknown>;
  if (bill.status !== "final" || bill.unit !== "micro-USD" || !ref(bill.operationRef,256) ||
      !ref(bill.reference,256) || !units(bill.actualMicroUsd)) throw new Error("Final auxiliary bill required");
  const row = await stored(access,id);
  if (!row) throw new Error("Auxiliary cost unavailable");
  if (row.operation_ref !== bill.operationRef) throw new Error("Auxiliary bill attribution mismatch");
  if (row.actual_units !== null) {
    if (row.actual_units !== bill.actualMicroUsd || row.billing_ref !== bill.reference) throw new Error("Auxiliary settlement conflict");
    return { id, settled: true, replay: true };
  }
  const result = await access.db.prepare(`INSERT INTO auxiliary_cost_settlements
    (tenant_id,reservation_id,operation_ref,billing_ref,actual_units,actor) VALUES(?,?,?,?,?,?) RETURNING reservation_id`)
    .bind(access.tenantId,id,bill.operationRef,bill.reference,bill.actualMicroUsd,access.principalId).all<{ reservation_id: string }>();
  if (!result.success || result.results?.length !== 1 || result.results[0].reservation_id !== id) throw new Error("Auxiliary settlement failed");
  return { id, settled: true, replay: false };
}
