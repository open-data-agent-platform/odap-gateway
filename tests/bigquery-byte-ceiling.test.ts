import { describe, expect, it } from "vitest";
import { bigQueryByteCeiling } from "../lib/bigquery-byte-ceiling";

describe("BigQuery scan byte ceiling", () => {
  const tib = 2 ** 40;
  it("applies the stricter of reservation and policy", () => {
    expect(bigQueryByteCeiling(5, tib, 100)).toBe(5);
    expect(bigQueryByteCeiling(100, tib, 5)).toBe(5);
  });
  it("floors exactly when floating-point arithmetic would grant an extra byte", () => {
    expect(bigQueryByteCeiling(tib + 2, tib + 1, Number.MAX_SAFE_INTEGER)).toBe(tib);
    expect(bigQueryByteCeiling(Number.MAX_SAFE_INTEGER, 1, Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => bigQueryByteCeiling(1, tib + 1, 100)).toThrow("cannot cover");
  });
  it.each([0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])("rejects invalid numeric input %s", n => {
    expect(() => bigQueryByteCeiling(n, 1, 1)).toThrow();
    expect(() => bigQueryByteCeiling(1, n, 1)).toThrow();
    expect(() => bigQueryByteCeiling(1, 1, n)).toThrow();
  });
});
