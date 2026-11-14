import { afterEach, describe, expect, it, vi } from "vitest";
import { recordReviewedCancellation, recoverReviewedCancellation } from "../lib/owner-cancellation-request";
import type { RecoveryReport } from "../lib/recovery-inspection";
import { cancellationInspectionFixture } from "./fixtures/cancellation-inspection";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); });
const signal = () => new AbortController().signal;
async function fixture() {
  const { data, body } = await cancellationInspectionFixture();
  const reviewed: RecoveryReport = { tenantId: "t", intentId: "i", jobReference: {
    projectId: data.job.projectId, location: data.job.location, jobId: data.job.jobId },
    receiptId: data.job.pendingReceiptId, observation: null, source: "stored-evidence",
    providerContacted: false, executionAuthorized: false, settlementAuthorized: false };
  const ack = { ok: true, cancellationRequest: { tenantId: "t", intentId: "i", requestedBy: data.request.requestedBy,
    requestedAt: data.request.requestedAt, scope: "recorded-request-only", providerContacted: false,
    cancellationConfirmed: false, cancellationAuthorized: false, executionAuthorized: false, settlementAuthorized: false } };
  const send = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ ok: true, recovery: reviewed }))
    .mockResolvedValueOnce(Response.json(ack)).mockResolvedValueOnce(Response.json(body));
  return { reviewed, ack, body, send };
}

describe("explicit owner cancellation request", () => {
  it("rereads the reviewed job, posts once, then verifies the original recorded request", async () => {
    const f = await fixture(), result = await recordReviewedCancellation(f.reviewed, signal(), f.send);
    expect(result).toMatchObject({ state: "recorded", report: { requestedBy: "later-owner", requestedAt: f.ack.cancellationRequest.requestedAt } });
    expect(f.send.mock.calls.map(c => [c[0], c[1]?.method])).toEqual([
      ["/api/control/t/job-recovery/i", "GET"], ["/api/control/t/cancellation-requests", "POST"], ["/api/control/t/cancellation-evidence/i", "GET"]]);
    expect(f.send.mock.calls[1][1]).toMatchObject({ credentials: "same-origin", cache: "no-store", redirect: "error",
      headers: { "Content-Type": "application/json" }, body: '{"intentId":"i"}' });
    expect(f.send.mock.calls.every(c => c[1]?.signal instanceof AbortSignal)).toBe(true);
    expect(result).not.toHaveProperty("outcome");
  });
  it("uses mounted paths for all three steps", async () => {
    vi.stubEnv("NEXT_PUBLIC_GATEWAY_BASE_PATH", "/gateway");
    const f = await fixture(); expect((await recordReviewedCancellation(f.reviewed, signal(), f.send)).state).toBe("recorded");
    expect(f.send.mock.calls.every(c => String(c[0]).startsWith("/gateway/api/control/t/"))).toBe(true);
  });
  it.each(["tenant", "intent", "terminal", "source", "provider", "execution", "settlement"])("refuses an ineligible %s review before sending", async field => {
    const f = await fixture();
    if (field === "tenant") f.reviewed.tenantId = "../peer";
    if (field === "intent") f.reviewed.intentId = "";
    if (field === "terminal") f.reviewed.observation = { state: "cancelled", billedBytes: null, observedBy: "owner", observedAt: "2026-01-01" };
    if (field === "source") Object.assign(f.reviewed, { source: "live" });
    if (field === "provider") Object.assign(f.reviewed, { providerContacted: true });
    if (field === "execution") Object.assign(f.reviewed, { executionAuthorized: true });
    if (field === "settlement") Object.assign(f.reviewed, { settlementAuthorized: true });
    expect(await recordReviewedCancellation(f.reviewed, signal(), f.send)).toEqual({ state: "ineligible" }); expect(f.send).not.toHaveBeenCalled();
  });
  it.each(["project", "location", "job", "receipt", "terminal"])("does not post after the reviewed %s changes", async field => {
    const f = await fixture(), fresh = structuredClone(f.reviewed);
    if (field === "project") fresh.jobReference.projectId = "other";
    if (field === "location") fresh.jobReference.location = "EU";
    if (field === "job") fresh.jobReference.jobId = "other";
    if (field === "receipt") fresh.receiptId = "other";
    if (field === "terminal") fresh.observation = { state: "succeeded", billedBytes: 0, observedBy: "owner", observedAt: "2026-01-01" };
    const send = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: true, recovery: fresh }));
    expect((await recordReviewedCancellation(f.reviewed, signal(), send)).state).not.toBe("recorded");
    expect(send).toHaveBeenCalledTimes(1);
  });
  it.each([[401, "unauthenticated", "unauthenticated"], [403, "tenant_access_denied", "denied"],
    [503, "delegation_not_configured", "incompatible"], [503, "control_storage_unavailable", "unknown"]] as const)
    ("does not post when fresh review returns %i/%s", async (status, code, state) => {
      const f = await fixture(), send = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: false, code }, { status }));
      expect(await recordReviewedCancellation(f.reviewed, signal(), send)).toEqual({ state }); expect(send).toHaveBeenCalledTimes(1);
    });
  it.each([[401, "unauthenticated", "unauthenticated"], [403, "cancellation_request_denied", "denied"],
    [409, "cancellation_request_unavailable", "ineligible"], [503, "delegation_not_configured", "incompatible"],
    [503, "control_storage_unavailable", "unknown"], [500, "private", "unknown"]] as const)
    ("handles %i/%s without an automatic repeat", async (status, code, state) => {
      const f = await fixture(), send = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ ok: true, recovery: f.reviewed }))
        .mockResolvedValue(Response.json({ ok: false, code }, { status }));
      expect(await recordReviewedCancellation(f.reviewed, signal(), send)).toEqual({ state }); expect(send).toHaveBeenCalledTimes(2);
    });
  it.each(["tenantId", "intentId", "requestedBy", "requestedAt", "scope", "providerContacted",
    "cancellationConfirmed", "cancellationAuthorized", "executionAuthorized", "settlementAuthorized"])
    ("does not trust missing or changed acknowledgement %s", async field => {
      for (const absent of [false, true]) {
        const f = await fixture(), ack = f.ack.cancellationRequest as Record<string, unknown>;
        if (absent) delete ack[field]; else ack[field] = typeof ack[field] === "boolean" ? true : "changed";
        const send = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ ok: true, recovery: f.reviewed }))
          .mockResolvedValueOnce(Response.json(f.ack)).mockResolvedValueOnce(Response.json(f.body));
        expect(await recordReviewedCancellation(f.reviewed, signal(), send)).toEqual({ state: "unknown" });
        expect(send.mock.calls.filter(c => c[1]?.method === "POST")).toHaveLength(1);
      }
    });
  it.each(["extra", "array", "wrong-status", "bad-json"])("rejects a %s acknowledgement", async kind => {
    const f = await fixture();
    const response = kind === "bad-json" ? new Response("{") : Response.json(kind === "array" ? [] :
      kind === "extra" ? { ...f.ack, outcome: "cancelled" } : f.ack, { status: kind === "wrong-status" ? 201 : 200 });
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ ok: true, recovery: f.reviewed })).mockResolvedValueOnce(response);
    expect(await recordReviewedCancellation(f.reviewed, signal(), send)).toEqual({ state: "unknown" }); expect(send).toHaveBeenCalledTimes(2);
  });
  it("does not count an acknowledgement when stored evidence is denied or damaged", async () => {
    for (const response of [Response.json({ ok: false, code: "tenant_access_denied" }, { status: 403 }), Response.json({ ok: true, evidence: {} })]) {
      const f = await fixture(), send = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ ok: true, recovery: f.reviewed }))
        .mockResolvedValueOnce(Response.json(f.ack)).mockResolvedValueOnce(response);
      expect((await recordReviewedCancellation(f.reviewed, signal(), send)).state).not.toBe("recorded"); expect(send).toHaveBeenCalledTimes(3);
    }
  });
  it("recovers existing evidence with only a read and refuses another reviewed job", async () => {
    const f = await fixture(), read = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(f.body));
    expect((await recoverReviewedCancellation(f.reviewed, signal(), read)).state).toBe("recorded");
    f.reviewed.jobReference.projectId = "other";
    expect(await recoverReviewedCancellation(f.reviewed, signal(), read)).toEqual({ state: "unknown" });
    expect(read.mock.calls.every(c => c[1]?.method === "GET")).toBe(true);
  });
  it("rejects invalid recovery scope and pre-aborted commands without a request", async () => {
    const f = await fixture(), abort = new AbortController(); abort.abort();
    expect(await recordReviewedCancellation(f.reviewed, abort.signal, f.send)).toEqual({ state: "unknown" });
    expect(await recoverReviewedCancellation(f.reviewed, abort.signal, f.send)).toEqual({ state: "unknown" });
    f.reviewed.tenantId = ""; expect(await recoverReviewedCancellation(f.reviewed, signal(), f.send)).toEqual({ state: "ineligible" });
    expect(f.send).not.toHaveBeenCalled();
  });
  it("bounds a stalled acknowledgement even if cancelling the stream stalls", async () => {
    const f = await fixture(); vi.useFakeTimers();
    let entered!: () => void; const submitting = new Promise<void>(resolve => { entered = resolve; });
    const cancel = vi.fn(() => new Promise<void>(() => {})), send = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ ok: true, recovery: f.reviewed }))
      .mockImplementationOnce(async () => { entered(); return new Response(new ReadableStream({ cancel })); });
    const pending = recordReviewedCancellation(f.reviewed, signal(), send); await submitting; await vi.advanceTimersByTimeAsync(15001);
    expect(await pending).toEqual({ state: "unknown" }); expect(send).toHaveBeenCalledTimes(2); expect(cancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("refuses oversized acknowledgements and never reads subsequent evidence", async () => {
    const f = await fixture(), cancel = vi.fn(), send = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ ok: true, recovery: f.reviewed }))
      .mockResolvedValueOnce(new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(8193)); }, cancel }), { headers: { "Content-Length": "1" } }));
    expect(await recordReviewedCancellation(f.reviewed, signal(), send)).toEqual({ state: "unknown" });
    expect(send).toHaveBeenCalledTimes(2); expect(cancel).toHaveBeenCalledTimes(1);
  });
  it("a late fresh review cannot cause a post after the whole-operation deadline", async () => {
    const f = await fixture(); vi.useFakeTimers(); let release!: (r: Response) => void;
    const send = vi.fn<typeof fetch>().mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const pending = recordReviewedCancellation(f.reviewed, signal(), send); await vi.advanceTimersByTimeAsync(15001);
    expect(await pending).toEqual({ state: "unknown" }); release(Response.json({ ok: true, recovery: f.reviewed }));
    await vi.advanceTimersByTimeAsync(1); expect(send).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });
  it("does not restore a result after abort or repeat a lost acknowledgement", async () => {
    const f = await fixture(), abort = new AbortController();
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ ok: true, recovery: f.reviewed }))
      .mockImplementationOnce(async () => { abort.abort(); return Response.json(f.ack); });
    expect(await recordReviewedCancellation(f.reviewed, abort.signal, send)).toEqual({ state: "unknown" }); expect(send).toHaveBeenCalledTimes(2);
    const lost = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ ok: true, recovery: f.reviewed })).mockRejectedValueOnce(new Error("private"));
    expect(await recordReviewedCancellation(f.reviewed, signal(), lost)).toEqual({ state: "unknown" }); expect(lost).toHaveBeenCalledTimes(2);
  });
});
