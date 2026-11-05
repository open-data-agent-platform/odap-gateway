// All ledger and rate inputs are safe integers; their intermediate product
// is not. Floor the reservation-derived limit, never round up to one byte.
export function bigQueryByteCeiling(reservedMicroUsd: number, microUsdPerTiB: number, maxJobBytes: number): number {
  if (![reservedMicroUsd, microUsdPerTiB, maxJobBytes].every(n => Number.isSafeInteger(n) && n > 0)) {
    throw new Error("Positive reservation, scan rate and job limit required");
  }
  const affordable = BigInt(reservedMicroUsd) * (1n << 40n) / BigInt(microUsdPerTiB);
  if (affordable === 0n) throw new Error("Reservation cannot cover one billed byte");
  return affordable < BigInt(maxJobBytes) ? Number(affordable) : maxJobBytes;
}
