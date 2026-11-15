export const RESOURCE_UNITS = Object.freeze(["billed-bytes", "elapsed-ms", "returned-rows", "memory-bytes"] as const);
export type ResourceUnit = typeof RESOURCE_UNITS[number];
export type ResourceLimit = { unit: ResourceUnit; maximum: number };
export type LinearResourceRate = {
  kind: "linear";
  resourceUnit: ResourceUnit;
  unitsPerRate: number;
  microUsdPerRate: number;
};

export function isResourceUnit(value: unknown): value is ResourceUnit {
  return RESOURCE_UNITS.some(unit => unit === value);
}

export function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

// Offline arithmetic only: a caller-supplied rate is not verified pricing,
// a ledger reservation, or proof that an engine enforces this resource limit.
export function resourceCeiling(reservation: { unit: "micro-usd"; maximum: number },
  rate: LinearResourceRate | { kind: "unknown" }, limit: ResourceLimit): ResourceLimit {
  if (!reservation || reservation.unit !== "micro-usd" || !positiveSafeInteger(reservation.maximum) ||
      !limit || !isResourceUnit(limit.unit) || !positiveSafeInteger(limit.maximum)) {
    throw new Error("Invalid reservation or resource limit");
  }
  if (!rate || rate.kind !== "linear") throw new Error("Known linear pricing required");
  if (rate.resourceUnit !== limit.unit || !positiveSafeInteger(rate.unitsPerRate) ||
      !positiveSafeInteger(rate.microUsdPerRate)) throw new Error("Invalid or mismatched resource rate");
  const affordable = BigInt(reservation.maximum) * BigInt(rate.unitsPerRate) / BigInt(rate.microUsdPerRate);
  if (affordable === 0n) throw new Error("Reservation cannot cover one resource unit");
  return { unit: limit.unit, maximum: affordable < BigInt(limit.maximum) ? Number(affordable) : limit.maximum };
}
