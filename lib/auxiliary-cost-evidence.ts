import { canonicalControlJson, isControlTimestamp, sha256Text } from "./control-objects";

export const auxiliaryCostProfile = "odap.gateway.local.auxiliary-costs.v1";
export const auxiliaryCostScope = "recorded-auxiliary-components-only";
export const auxiliaryCostMaxComponents = 1024;
export const auxiliaryCostMaxBytes = 4 * 1024 * 1024;

function fields(value: unknown, keys: string): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const names = keys.split(" ");
  return Object.keys(value).length === names.length && names.every(key => Object.hasOwn(value, key));
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 1024 && !/[\u0000-\u001f\u007f]/.test(value);
}
function reference(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && !/[^a-zA-Z0-9:._/-]/.test(value);
}
function digest(value: unknown): value is string {
  return typeof value === "string" && value.length === 71 && /^sha256:[a-f0-9]{64}$/.test(value);
}
function natural(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
}

// Detached consistency only: neither a provider signature nor an inventory of unrecorded operations.
export async function verifyAuxiliaryCostEvidence(json: string, scope: { tenantId: string; intentId: string }, expectedDigest?: string) {
  if (typeof json !== "string" || json.length > auxiliaryCostMaxBytes ||
      new TextEncoder().encode(json).length > auxiliaryCostMaxBytes) throw new Error("Invalid auxiliary evidence size");
  const data: unknown = JSON.parse(json);
  if (!fields(data, "profile scope intent components") || data.profile !== auxiliaryCostProfile || data.scope !== auxiliaryCostScope ||
      !fields(data.intent, "tenantId intentId contractId budgetId principalId reservationId actionDigest") ||
      !Array.isArray(data.components) || data.components.length > auxiliaryCostMaxComponents) throw new Error("Invalid auxiliary evidence profile");
  const { intent, components } = data;
  if (![intent.tenantId,intent.intentId,intent.contractId,intent.budgetId,intent.principalId,intent.reservationId].every(text) ||
      !digest(intent.actionDigest)) throw new Error("Invalid auxiliary intent");
  if (intent.tenantId !== scope.tenantId || intent.intentId !== scope.intentId) throw new Error("Evidence scope mismatch");
  const operations = new Set<string>(), bills = new Set<string>(), events = new Set<number>();
  let priorId = "", settled = 0, actual = 0n, pending = 0n;
  const audit = (records: unknown, id: string, kind: string, actor: unknown, at: unknown) => {
    if (!Array.isArray(records) || records.length !== 1) throw new Error("Missing or duplicate component audit");
    const event = records[0];
    if (!fields(event, "sequence tenantId objectId kind actor recordedAt") || !natural(event.sequence) || event.sequence === 0 ||
        events.has(event.sequence) || event.tenantId !== intent.tenantId || event.objectId !== id ||
        event.kind !== kind || event.actor !== actor || event.recordedAt !== at) throw new Error("Component audit mismatch");
    events.add(event.sequence);
    return event.sequence;
  };
  for (const component of components) {
    if (!fields(component, "id kind operationRef operationDigest upperBoundMicroUsd reservedBy reservedAt reservationEvents settlement settlementEvents") ||
        !reference(component.id,128) || component.id <= priorId || typeof component.kind !== "string" || !["model","tool"].includes(component.kind) ||
        !reference(component.operationRef,256) || operations.has(component.operationRef) || !digest(component.operationDigest) ||
        !natural(component.upperBoundMicroUsd) || component.upperBoundMicroUsd === 0 || !text(component.reservedBy) ||
        !isControlTimestamp(component.reservedAt)) throw new Error("Invalid auxiliary component");
    priorId = component.id;
    operations.add(component.operationRef);
    const reservedEvent = audit(component.reservationEvents, component.id, "auxiliary_cost_reserved", component.reservedBy, component.reservedAt);
    if (component.settlement === null) {
      if (!Array.isArray(component.settlementEvents) || component.settlementEvents.length !== 0) throw new Error("Unexpected settlement audit");
      pending += BigInt(component.upperBoundMicroUsd);
      continue;
    }
    const bill = component.settlement;
    if (!fields(bill, "operationRef billingRef actualMicroUsd actor recordedAt") || bill.operationRef !== component.operationRef ||
        !reference(bill.billingRef,256) || bills.has(bill.billingRef) || !natural(bill.actualMicroUsd) ||
        !text(bill.actor) || !isControlTimestamp(bill.recordedAt) ||
        Date.parse(bill.recordedAt as string) < Date.parse(component.reservedAt as string)) throw new Error("Invalid auxiliary settlement");
    const settledEvent = audit(component.settlementEvents, component.id, "auxiliary_cost_settled", bill.actor, bill.recordedAt);
    if (settledEvent <= reservedEvent) throw new Error("Invalid component audit chronology");
    bills.add(bill.billingRef);
    actual += BigInt(bill.actualMicroUsd);
    settled += 1;
  }
  if (canonicalControlJson(data) !== json) throw new Error("Noncanonical evidence JSON");
  const checksum = await sha256Text(json);
  if (expectedDigest !== undefined && checksum !== expectedDigest) throw new Error("Evidence checksum mismatch");
  return { consistent: true as const, issuerAuthenticated: false as const, completeWorkflowCost: false as const,
    scope: auxiliaryCostScope, digest: checksum, recordedComponents: components.length, settledComponents: settled,
    pendingComponents: components.length - settled, allRecordedComponentsSettled: components.length === settled,
    settledActualMicroUsd: actual.toString(), pendingReservedMicroUsd: pending.toString() };
}
