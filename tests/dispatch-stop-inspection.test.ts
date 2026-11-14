import { afterEach, describe, expect, it, vi } from "vitest";
import { inspectDispatchStop, recordReviewedDispatchStop, type DispatchStopReport } from "../lib/dispatch-stop-inspection";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); });
const signal = () => new AbortController().signal;
const report = (): Extract<DispatchStopReport, { state: "not-stopped" }> => ({ tenantId: "t", intentId: "i", state: "not-stopped", source: "stored-evidence",
  scope: "local-dispatch-stop", providerContacted: false, cancellationConfirmed: false, executionAuthorized: false, settlementAuthorized: false });
const stopped = () => ({ ...report(), state: "stopped" as const, stoppedBy: "google:original-owner", stoppedAt: "2026-01-01T00:00:00.000Z" });
const response = (r: unknown = report()) => Response.json({ ok: true, dispatchStop: r });
const ack = () => { const value: Record<string, unknown> = { ...stopped() }; delete value.state; delete value.source; return { ok: true, dispatchStop: value }; };
const refusal = (status: number, code: string) => Response.json({ ok: false, code }, { status });

describe("bounded owner stop inspection", () => {
  it.each(["not-stopped", "stopped", "legacy-stop", "already-claimed", "already-settled"] as const)("reads %s without inventing authority or attribution", async state => {
    const value = state === "stopped" ? stopped() : { ...report(), state }, get = vi.fn<typeof fetch>().mockResolvedValue(response(value));
    expect(await inspectDispatchStop("t", "i", signal(), get)).toEqual({ state: "ready", report: value });
    expect(get).toHaveBeenCalledTimes(1); expect(get.mock.calls[0][0]).toBe("/api/control/t/dispatch-stops/i");
    expect(get.mock.calls[0][1]).toMatchObject({ method: "GET", credentials: "same-origin", cache: "no-store", redirect: "error" });
    expect(get.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
  });
  it("honors the mount", async () => {
    vi.stubEnv("NEXT_PUBLIC_GATEWAY_BASE_PATH", "/gateway"); const get = vi.fn<typeof fetch>().mockResolvedValue(response());
    await inspectDispatchStop("t", "i", signal(), get); expect(get.mock.calls[0][0]).toBe("/gateway/api/control/t/dispatch-stops/i");
  });
  it.each(["", "../peer", "x/y", "t?stop=1", "t#i", "t%2fi", "t\n", "x".repeat(129)])("rejects scope %# before a request", async value => {
    const get = vi.fn();
    expect(await inspectDispatchStop(value, "i", signal(), get)).toEqual({ state: "invalid" });
    expect(await inspectDispatchStop("t", value, signal(), get)).toEqual({ state: "invalid" }); expect(get).not.toHaveBeenCalled();
  });
  it.each([[401,"unauthenticated","unauthenticated"], [403,"tenant_access_denied","denied"],
    [503,"control_storage_unavailable","unavailable"], [409,"dispatch_stop_unavailable","unavailable"], [404,"missing","unavailable"]] as const)
    ("keeps %s refusal separate from absent state", async (status, code, state) => {
      expect(await inspectDispatchStop("t","i",signal(),async () => refusal(status,code))).toEqual({ state });
    });
  it.each(["tenantId", "intentId", "state", "source", "scope", "providerContacted", "cancellationConfirmed", "executionAuthorized", "settlementAuthorized"])
    ("rejects changed or missing report %s", async key => {
      for (const absent of [true,false]) {
        const value = { ...report() } as Record<string, unknown>;
        if (absent) delete value[key]; else value[key] = typeof value[key] === "boolean" ? true : "changed";
        expect(await inspectDispatchStop("t","i",signal(),async () => response(value))).toEqual({ state: "unavailable" });
      }
    });
  it.each(["", " ", "owner\nprivate", "x".repeat(513), null, 123])("rejects malformed actor %#", async stoppedBy => {
    expect(await inspectDispatchStop("t","i",signal(),async () => response({ ...stopped(), stoppedBy }))).toEqual({ state: "unavailable" });
  });
  it.each(["2026-02-30T00:00:00.000Z", "yesterday", "2026-01-01", null, 123])("rejects malformed time %#", async stoppedAt => {
    expect(await inspectDispatchStop("t","i",signal(),async () => response({ ...stopped(), stoppedAt }))).toEqual({ state: "unavailable" });
  });
  it("rejects unexpected attribution, fields, envelopes, statuses and JSON", async () => {
    for (const r of [response({ ...report(), stoppedBy: "owner" }), response({ ...stopped(), sql: "private" }), Response.json([]),
      Response.json({ ok: true, dispatchStop: report(), extra: true }), Response.json({ ok: false, dispatchStop: report() }),
      Response.json({ ok: true, dispatchStop: report() }, { status: 201 }), new Response("{")]) {
      expect(await inspectDispatchStop("t","i",signal(),async () => r)).toEqual({ state: "unavailable" });
    }
  });
  it("does not fetch on pre-abort or return a late aborted result", async () => {
    const abort = new AbortController(); abort.abort(); const get = vi.fn();
    expect(await inspectDispatchStop("t","i",abort.signal,get)).toEqual({ state: "unavailable" }); expect(get).not.toHaveBeenCalled();
    const late = new AbortController(); expect(await inspectDispatchStop("t","i",late.signal,async () => { late.abort(); return response(); })).toEqual({ state: "unavailable" });
  });
  it.each(["oversized", "utf8"])("refuses %s without trusting content length", async kind => {
    const cancel = vi.fn(), bytes = kind === "utf8" ? Uint8Array.from([0xff]) : new TextEncoder().encode("界".repeat(3000));
    const r = new Response(new ReadableStream({ start(c) { c.enqueue(bytes); if (kind === "utf8") c.close(); }, cancel }), { headers: { "Content-Length": "1" } });
    expect(await inspectDispatchStop("t","i",signal(),async () => r)).toEqual({ state: "unavailable" });
    if (kind === "oversized") expect(cancel).toHaveBeenCalledTimes(1);
  });
  it("bounds a stalled stream even when cancellation stalls", async () => {
    vi.useFakeTimers(); const cancel = vi.fn(() => new Promise<void>(() => {}));
    const pending = inspectDispatchStop("t","i",signal(),async () => new Response(new ReadableStream({ cancel })));
    await vi.advanceTimersByTimeAsync(15001); expect(await pending).toEqual({ state: "unavailable" });
    expect(cancel).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });
});

describe("explicit owner stop confirmation", () => {
  it("freshly reads, posts once, then separately verifies original attribution", async () => {
    vi.stubEnv("NEXT_PUBLIC_GATEWAY_BASE_PATH", "/gateway");
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(response()).mockResolvedValueOnce(Response.json(ack())).mockResolvedValueOnce(response(stopped()));
    expect(await recordReviewedDispatchStop(report(),signal(),send)).toEqual({ state: "ready", report: stopped() });
    expect(send.mock.calls.map(c => [c[0],c[1]?.method])).toEqual([["/gateway/api/control/t/dispatch-stops/i","GET"],
      ["/gateway/api/control/t/dispatch-stops","POST"],["/gateway/api/control/t/dispatch-stops/i","GET"]]);
    expect(send.mock.calls[1][1]).toMatchObject({ body: '{"intentId":"i"}', headers: { "Content-Type": "application/json" },
      credentials: "same-origin", cache: "no-store", redirect: "error" });
  });
  it.each(["stopped", "legacy-stop", "already-claimed", "already-settled"] as const)("does not submit reviewed or fresh %s", async state => {
    const value = state === "stopped" ? stopped() : { ...report(), state }, send = vi.fn<typeof fetch>().mockResolvedValue(response(value));
    expect(await recordReviewedDispatchStop(value,signal(),send)).toEqual({ state: "ineligible" }); expect(send).not.toHaveBeenCalled();
    expect(await recordReviewedDispatchStop(report(),signal(),send)).toEqual({ state: "ineligible" }); expect(send).toHaveBeenCalledTimes(1);
  });
  it.each(["tenantId", "intentId", "source", "providerContacted", "executionAuthorized"])("refuses invalid reviewed %s", async key => {
    const value = { ...report(), [key]: key.endsWith("Id") ? "../peer" : true }, send = vi.fn();
    expect(await recordReviewedDispatchStop(value as DispatchStopReport,signal(),send)).toEqual({ state: "ineligible" }); expect(send).not.toHaveBeenCalled();
  });
  it.each([[401,"unauthenticated","unauthenticated"], [403,"tenant_access_denied","denied"],
    [409,"dispatch_stop_unavailable","ineligible"], [503,"control_storage_unavailable","unknown"]] as const)
    ("handles command %s without retry", async (status, code, state) => {
      const send = vi.fn<typeof fetch>().mockResolvedValueOnce(response()).mockResolvedValueOnce(refusal(status,code));
      expect(await recordReviewedDispatchStop(report(),signal(),send)).toEqual({ state }); expect(send).toHaveBeenCalledTimes(2);
    });
  it.each(["tenantId", "intentId", "scope", "stoppedBy", "stoppedAt", "providerContacted", "cancellationConfirmed", "executionAuthorized", "settlementAuthorized"])
    ("rejects changed/missing command acknowledgement %s", async key => {
      for (const absent of [true,false]) {
        const value = ack(), record = value.dispatchStop as Record<string,unknown>;
        if (absent) delete record[key]; else record[key] = typeof record[key] === "boolean" ? true : "changed";
        const send = vi.fn<typeof fetch>().mockResolvedValueOnce(response()).mockResolvedValueOnce(Response.json(value)).mockResolvedValueOnce(response(stopped()));
        expect(await recordReviewedDispatchStop(report(),signal(),send)).toEqual({ state: "unknown" });
        expect(send.mock.calls.filter(c => c[1]?.method === "POST")).toHaveLength(1);
      }
    });
  it.each(["not-stopped", "different-actor", "different-time", "denied"])("does not trust acknowledgement when readback is %s", async kind => {
    const saved = kind === "denied" ? refusal(403,"tenant_access_denied") : kind === "not-stopped" ? response() :
      response({ ...stopped(), ...(kind === "different-actor" ? { stoppedBy: "other" } : { stoppedAt: "2026-01-02T00:00:00.000Z" }) });
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(response()).mockResolvedValueOnce(Response.json(ack())).mockResolvedValueOnce(saved);
    expect(await recordReviewedDispatchStop(report(),signal(),send)).toEqual({ state: kind === "denied" ? "denied" : "unknown" });
    expect(send).toHaveBeenCalledTimes(3);
  });
  it("recovers a lost command response with only a GET", async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(response()).mockRejectedValueOnce(new Error("private"));
    expect(await recordReviewedDispatchStop(report(),signal(),send)).toEqual({ state: "unknown" }); expect(send).toHaveBeenCalledTimes(2);
    const read = vi.fn<typeof fetch>().mockResolvedValue(response(stopped()));
    expect(await inspectDispatchStop("t","i",signal(),read)).toEqual({ state: "ready", report: stopped() });
    expect(read.mock.calls.every(c => c[1]?.method === "GET")).toBe(true);
  });
  it("refuses pre-abort and ignores late fresh review without posting", async () => {
    const abort = new AbortController(); abort.abort(); const none = vi.fn();
    expect(await recordReviewedDispatchStop(report(),abort.signal,none)).toEqual({ state: "unknown" }); expect(none).not.toHaveBeenCalled();
    vi.useFakeTimers(); let release!: (r: Response) => void;
    const send = vi.fn<typeof fetch>().mockImplementation(() => new Promise(r => { release = r; }));
    const pending = recordReviewedDispatchStop(report(),signal(),send); await vi.advanceTimersByTimeAsync(15001);
    expect(await pending).toEqual({ state: "unknown" }); release(response()); await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });
  it("bounds a stalled command acknowledgement without automatic repeat", async () => {
    vi.useFakeTimers(); let entered!: () => void; const posting = new Promise<void>(r => { entered = r; });
    const cancel = vi.fn(() => new Promise<void>(() => {})), send = vi.fn<typeof fetch>().mockResolvedValueOnce(response())
      .mockImplementationOnce(async () => { entered(); return new Response(new ReadableStream({ cancel })); });
    const pending = recordReviewedDispatchStop(report(),signal(),send); await posting; await vi.advanceTimersByTimeAsync(15001);
    expect(await pending).toEqual({ state: "unknown" }); expect(send).toHaveBeenCalledTimes(2); expect(cancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
