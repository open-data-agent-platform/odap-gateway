import { describe, expect, it, vi } from "vitest";
import { intentJobId } from "../lib/bigquery-job-identity";
import { inspectRecovery, type RecoveryReport } from "../lib/recovery-inspection";

const signal = new AbortController().signal;
async function stored(): Promise<RecoveryReport> {
  const jobId = await intentJobId("team-a", "intent-a");
  return { tenantId: "team-a", intentId: "intent-a", jobReference: { projectId: "project-a", location: "US", jobId },
    receiptId: "pending_" + jobId, observation: null, source: "stored-evidence",
    providerContacted: false, executionAuthorized: false, settlementAuthorized: false };
}
const read = (recovery: unknown) => inspectRecovery("team-a", "intent-a", signal,
  async () => Response.json({ ok: true, recovery }));
const observation = () => ({ state: "succeeded" as const, billedBytes: 0, observedAt: "2026-07-01 12:00:00", observedBy: "owner-a" });

describe("owner stored recovery inspection", () => {
  it("uses one same-origin uncached GET, with no caller authority or provider refresh", async () => {
    const report = await stored(), get = vi.fn(async () => Response.json({ ok: true, recovery: report }));
    expect(await inspectRecovery("team-a", "intent-a", signal, get)).toEqual({ state: "ready", report });
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith("/api/control/team-a/job-recovery/intent-a", {
      method: "GET", credentials: "same-origin", cache: "no-store", redirect: "error", signal
    });
    expect(report.observation).toBeNull();
  });
  it("honors the configured Gateway mount", async () => {
    vi.stubEnv("NEXT_PUBLIC_GATEWAY_BASE_PATH", "/gateway");
    try {
      const get = vi.fn(async () => Response.json({ ok: true, recovery: await stored() }));
      expect((await inspectRecovery("team-a", "intent-a", signal, get)).state).toBe("ready");
      expect(get).toHaveBeenCalledWith("/gateway/api/control/team-a/job-recovery/intent-a", {
        method: "GET", credentials: "same-origin", cache: "no-store", redirect: "error", signal
      });
    } finally { vi.unstubAllEnvs(); }
  });
  it.each(["", "../peer", "other/team", "https://other.test", "t?q=1", "t#x", "t%2Fother", "x".repeat(129), " t", "t\n"])(
    "rejects invalid scope %# without fetching", async value => {
      const get = vi.fn();
      expect(await inspectRecovery(value, "intent-a", signal, get)).toEqual({ state: "invalid" });
      expect(await inspectRecovery("team-a", value, signal, get)).toEqual({ state: "invalid" });
      expect(get).not.toHaveBeenCalled();
    });
  it.each([[401, "unauthenticated"], [403, "denied"], [404, "unavailable"], [500, "unavailable"], [503, "unavailable"]] as const)(
    "does not convert HTTP %i into missing observation", async (status, state) => {
      expect(await inspectRecovery("team-a", "intent-a", signal,
        async () => Response.json({ ok: true, recovery: await stored() }, { status }))).toEqual({ state });
    });
  it.each(["job_recovery_unavailable", "delegation_not_configured"])("distinguishes %s without exposing diagnostics", async code => {
    expect(await inspectRecovery("team-a", "intent-a", signal, async () => Response.json({
      ok: false, code, detail: "private"
    }, { status: 503 }))).toEqual({ state: "incompatible" });
  });
  it("fails closed for network errors, malformed JSON and unexpected envelopes", async () => {
    const report = await stored();
    for (const get of [async () => { throw new Error("private"); }, async () => new Response("<html/>"),
      async () => Response.json({ ok: false, recovery: report }), async () => new Response("private", { status: 503 }),
      async () => Response.json({ ok: true, recovery: report, extra: "private" }), async () => Response.json([])])
      expect(await inspectRecovery("team-a", "intent-a", signal, get)).toEqual({ state: "unavailable" });
  });
  it.each(["succeeded", "failed", "cancelled"] as const)("preserves stored %s with unknown, zero and known bytes", async state => {
    for (const billedBytes of [null, 0, Number.MAX_SAFE_INTEGER]) {
      const report = { ...await stored(), observation: { ...observation(), state, billedBytes } };
      expect(await read(report)).toEqual({ state: "ready", report });
    }
  });
  it.each([
    ["tenant", { tenantId: "team-b" }], ["intent", { intentId: "intent-b" }], ["source", { source: "provider" }],
    ["provider contact", { providerContacted: true }], ["execution authority", { executionAuthorized: true }],
    ["settlement authority", { settlementAuthorized: true }], ["unknown field", { sql: "private" }],
    ["unbound receipt", { receiptId: "receipt-other" }], ["missing observation", { observation: undefined }],
    ["malformed observation", { observation: [] }], ["missing job", { jobReference: null }]
  ])("rejects wrong %s", async (_label, change) => {
    expect(await read({ ...await stored(), ...change })).toEqual({ state: "unavailable" });
  });
  it("rejects a validly shaped job and receipt bound to a different intent", async () => {
    const report = await stored(), jobId = await intentJobId("team-a", "intent-b");
    expect(await read({ ...report, jobReference: { ...report.jobReference, jobId }, receiptId: "pending_" + jobId }))
      .toEqual({ state: "unavailable" });
  });
  it.each(["", " ", "project\nprivate", "x".repeat(513), null, 123])("rejects malformed job location/project %#", async value => {
    const report = await stored();
    for (const key of ["projectId", "location"])
      expect(await read({ ...report, jobReference: { ...report.jobReference, [key]: value } })).toEqual({ state: "unavailable" });
  });
  it.each([-1, 0.5, "0", Number.MAX_SAFE_INTEGER + 1, true, {}])("rejects invalid byte counts %#", async billedBytes => {
    expect(await read({ ...await stored(), observation: { ...observation(), billedBytes } })).toEqual({ state: "unavailable" });
  });
  it.each([
    { state: "running" }, { state: "pending" }, { state: "unknown" }, { observedAt: "not-a-time" },
    { observedAt: null }, { observedBy: "" }, { observedBy: "owner\nprivate" }, { observedBy: 1 }, { charge: 0 }
  ])("rejects malformed terminal metadata %#", async change => {
    expect(await read({ ...await stored(), observation: { ...observation(), ...change } })).toEqual({ state: "unavailable" });
  });
});
