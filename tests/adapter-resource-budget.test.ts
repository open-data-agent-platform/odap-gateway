import { describe, expect, it } from "vitest";
import { resourceCeiling, RESOURCE_UNITS, type LinearResourceRate } from "../lib/adapter-resource-budget";
import { bigQueryByteCeiling } from "../lib/bigquery-byte-ceiling";

const reserve = (maximum: number) => ({ unit: "micro-usd" as const, maximum });
const rate: LinearResourceRate = { kind: "linear", resourceUnit: "billed-bytes", unitsPerRate: 2 ** 40, microUsdPerRate: 2 ** 40 };
const limit = (maximum: number) => ({ unit: "billed-bytes" as const, maximum });

describe("offline resource budget arithmetic", () => {
  it("keeps the resource vocabulary immutable at runtime", () => {
    expect(Object.isFrozen(RESOURCE_UNITS)).toBe(true);
  });
  it.each(RESOURCE_UNITS)("preserves explicit %s units", unit => {
    expect(resourceCeiling(reserve(3), { ...rate, resourceUnit: unit, unitsPerRate: 10, microUsdPerRate: 2 },
      { unit, maximum: 100 })).toEqual({ unit, maximum: 15 });
  });
  it("uses the strictest limit without mutating arguments", () => {
    const r = Object.freeze(reserve(100));
    const l = Object.freeze(limit(4));
    expect(resourceCeiling(r, Object.freeze(rate), l)).toEqual(limit(4));
  });
  it.each([0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects unsafe values %s", n => {
    expect(() => resourceCeiling(reserve(n), rate, limit(1))).toThrow();
    expect(() => resourceCeiling(reserve(1), rate, limit(n))).toThrow();
    expect(() => resourceCeiling(reserve(1), { ...rate, unitsPerRate: n }, limit(1))).toThrow();
    expect(() => resourceCeiling(reserve(1), { ...rate, microUsdPerRate: n }, limit(1))).toThrow();
  });
  it("does not treat unknown costs or incompatible units as free", () => {
    expect(() => resourceCeiling(reserve(10), { kind: "unknown" }, limit(10))).toThrow("Known linear");
    expect(() => resourceCeiling(reserve(10), { ...rate, resourceUnit: "elapsed-ms" }, limit(10))).toThrow("mismatched");
    expect(() => resourceCeiling({ unit: "usd", maximum: 10 } as never, rate, limit(10))).toThrow();
    expect(() => resourceCeiling(reserve(10), rate, { unit: "optimizer-cost", maximum: 10 } as never)).toThrow();
  });
  it("rejects insufficient funds instead of rounding up", () => {
    expect(() => resourceCeiling(reserve(1), { ...rate, microUsdPerRate: 2 ** 40 + 1 }, limit(10))).toThrow("cannot cover");
  });
  it("matches the existing BigQuery ceiling for boundary and generated cases", () => {
    const vectors = [[2 ** 40 + 2, 2 ** 40 + 1, Number.MAX_SAFE_INTEGER],
      [Number.MAX_SAFE_INTEGER, 1, Number.MAX_SAFE_INTEGER], [1, Number.MAX_SAFE_INTEGER, 10]];
    for (let n = 1; n <= 100; n++) vectors.push([n * 7919, n * 104729, n * 1543]);
    for (const [funds, price, maximum] of vectors) {
      let expected: number;
      try { expected = bigQueryByteCeiling(funds, price, maximum); }
      catch { expect(() => resourceCeiling(reserve(funds), { ...rate, microUsdPerRate: price }, limit(maximum))).toThrow(); continue; }
      expect(resourceCeiling(reserve(funds), { ...rate, microUsdPerRate: price }, limit(maximum))).toEqual(limit(expected));
    }
  });
});
