import { expect, it, vi } from "vitest";
import sample from "./fixtures/settled-job.json";
import { canonicalControlJson } from "../lib/control-objects";
import { settledEvidenceMaxBytes, verifySettledEvidence } from "../lib/settled-evidence";
import { exportSettledEvidence } from "../lib/settled-evidence-export";
import type { D1Database } from "../lib/d1";

const scope = { tenantId: "t", intentId: "i" };
it("accepts the exact UTF-8 limit and rejects one additional byte", async () => {
  const data = structuredClone(sample); data.final.reason = "x";
  const size = new TextEncoder().encode(canonicalControlJson(data)).length;
  data.final.reason += "x".repeat(settledEvidenceMaxBytes-size);
  const json = canonicalControlJson(data);
  expect(new TextEncoder().encode(json).length).toBe(settledEvidenceMaxBytes);
  await expect(verifySettledEvidence(json, scope)).resolves.toMatchObject({ consistent: true });
  await expect(verifySettledEvidence(json+" ", scope)).rejects.toThrow("Invalid settled evidence size");
});
it("bounds UTF-8 bytes, not just JavaScript string length, before parsing", async () => {
  const json = '"'+String.fromCodePoint(0x4e2d).repeat(Math.ceil(settledEvidenceMaxBytes/3))+'"';
  expect(json.length).toBeLessThan(settledEvidenceMaxBytes);
  const parse = vi.spyOn(JSON, "parse");
  try {
    await expect(verifySettledEvidence(json, scope)).rejects.toThrow("Invalid settled evidence size");
    expect(parse).not.toHaveBeenCalled();
  } finally { parse.mockRestore(); }
});
it.each([undefined, null, 12, {}, []])("rejects non-text input %# without parsing", async value => {
  await expect(verifySettledEvidence(value as string, scope)).rejects.toThrow("Invalid settled evidence size");
});
it.each([
  { evidence: "x".repeat(settledEvidenceMaxBytes+1), delegation: null },
  { evidence: "x".repeat(settledEvidenceMaxBytes), delegation: "{}" },
  { evidence: String.fromCodePoint(0x4e2d).repeat(Math.ceil(settledEvidenceMaxBytes/3)), delegation: null },
  { evidence: null, delegation: null }, { evidence: "{}", delegation: 12 }
])("bounds stored projection %# before parsing", async row => {
  const db = { prepare: () => ({ bind: () => ({ first: async () => row }) }) } as unknown as D1Database;
  await expect(exportSettledEvidence({ db, tenantId: "t", principalId: "owner" }, "i"))
    .rejects.toThrow("Invalid settled evidence size");
});
