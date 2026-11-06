import { describe, expect, it, vi } from "vitest";
import { inspectCoverage } from "../lib/coverage-inspection";

const signal = new AbortController().signal;
const empty = { recordedAttempts:0,admitted:0,missingReleaseRefusals:0,pendingOutcome:0,pendingBilling:0,
  attributedSettlements:0,unattributedSettlements:0,missingEvidence:0 };
const read = (coverage: unknown) => inspectCoverage("team-a",signal,async () => Response.json({ok:true,coverage}));

describe("owner coverage inspection", () => {
  it("reads only the selected tenant's same-origin, uncached aggregate", async () => {
    const coverage = { ...empty,recordedAttempts:3,admitted:2,missingReleaseRefusals:1,pendingBilling:1,missingEvidence:1 };
    const get = vi.fn(async () => Response.json({ok:true,coverage}));
    expect(await inspectCoverage("team-a",signal,get)).toEqual({ state:"ready",report:coverage });
    expect(get).toHaveBeenCalledWith("/api/control/team-a/evidence-coverage",{
      method:"GET", credentials:"same-origin", cache:"no-store", redirect:"error", signal
    });
    expect(await read(empty)).toEqual({ state:"ready",report:empty });
    expect((await read({ ...empty,recordedAttempts:1,missingReleaseRefusals:1 })).state).toBe("ready");
  });
  it.each(["", "../peer", "other/team", "https://other.test", "t?q=1", "x".repeat(129)])("does not fetch invalid input %s", async tenant => {
    const get = vi.fn();
    expect(await inspectCoverage(tenant,signal,get)).toEqual({ state:"invalid" });
    expect(get).not.toHaveBeenCalled();
  });
  it.each([[401,"unauthenticated"],[403,"denied"],[404,"unavailable"],[503,"unavailable"]] as const)(
    "preserves the distinction between HTTP %i and an empty result", async (status,state) => {
      expect(await inspectCoverage("t",signal,async () => Response.json({ok:true,coverage:empty},{status}))).toEqual({state});
    });
  it("rejects malformed, unexpected, imprecise or internally inconsistent counts", async () => {
    for (const coverage of [null, {}, { ...empty,rows:[] }, { ...empty,missingEvidence:-1 }, { ...empty,pendingBilling:"0" },
      { ...empty,admitted:0.5 }, { ...empty,recordedAttempts:Number.MAX_SAFE_INTEGER+1 }, { ...empty,recordedAttempts:1 },
      { ...empty,recordedAttempts:1,admitted:1 }]) expect(await read(coverage)).toEqual({state:"unavailable"});
    for (const get of [async () => { throw new Error("private"); }, async () => new Response("<html/>"),
      async () => Response.json({ok:false,coverage:empty})])
      expect(await inspectCoverage("t",signal,get)).toEqual({state:"unavailable"});
  });
});
