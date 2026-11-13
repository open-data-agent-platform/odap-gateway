import { afterEach, describe, expect, it, vi } from "vitest";
import * as cancellation from "../lib/bigquery-cancellation";
import { sendRequestedJobCancellation } from "../lib/bigquery-cancellation-transport";
import type { ControlAccess } from "../lib/control-storage";

const access = { db: {}, tenantId: "t", principalId: "owner" } as ControlAccess;
const jobReference = { projectId: "fixture-project", location: "US", jobId: "odap_" + "a".repeat(64) };
const stored = () => ({ state: "requested" as const, jobReference, request: { requestedBy: "owner", requestedAt: "fixture-time" } });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("bounded cancellation transport and late continuations", () => {
  it("times out an uncooperative token loader without a late cancellation", async () => {
    vi.useFakeTimers(); vi.spyOn(cancellation, "readJobCancellation").mockResolvedValue(stored());
    let resolve!: (value: string) => void;
    const sendOnce = vi.fn(), getAccessToken = vi.fn(() => new Promise<string>(done => { resolve = done; }));
    const result = sendRequestedJobCancellation(access, "i", { getAccessToken, sendOnce });
    const rejected = expect(result).rejects.toThrow(/^BigQuery cancellation transport unavailable$/);
    await vi.advanceTimersByTimeAsync(15000); await rejected;
    resolve("synthetic-late-token"); await vi.advanceTimersByTimeAsync(0);
    expect(sendOnce).not.toHaveBeenCalled(); expect(getAccessToken.mock.calls[0]).toHaveLength(1);
  });
  it("does not send after a final authority read returns beyond the deadline", async () => {
    vi.useFakeTimers(); let resolve!: (value: ReturnType<typeof stored>) => void;
    vi.spyOn(cancellation, "readJobCancellation").mockResolvedValueOnce(stored())
      .mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const sendOnce = vi.fn();
    const result = sendRequestedJobCancellation(access, "i", { getAccessToken: async () => "synthetic", sendOnce });
    const rejected = expect(result).rejects.toThrow("unavailable");
    await vi.advanceTimersByTimeAsync(15000); await rejected;
    resolve(stored()); await vi.advanceTimersByTimeAsync(0); expect(sendOnce).not.toHaveBeenCalled();
  });
  it("reports uncertainty and cancels a late response after a send timeout", async () => {
    vi.useFakeTimers(); vi.spyOn(cancellation, "readJobCancellation").mockResolvedValue(stored());
    let resolve!: (value: Response) => void, sent: Request | undefined;
    const sendOnce = vi.fn((request: Request) => { sent = request; return new Promise<Response>(done => { resolve = done; }); });
    const result = sendRequestedJobCancellation(access, "i", { getAccessToken: async () => "synthetic", sendOnce });
    await vi.advanceTimersByTimeAsync(15000);
    expect(await result).toEqual({ state: "observation-required", jobReference });
    expect(sent?.signal.aborted).toBe(true); expect(sendOnce).toHaveBeenCalledTimes(1);
    const cancel = vi.fn(); resolve(new Response(new ReadableStream({ cancel })));
    await vi.advanceTimersByTimeAsync(0); expect(cancel).toHaveBeenCalledTimes(1);
  });
  it("refuses a changed stored job after authentication", async () => {
    vi.spyOn(cancellation, "readJobCancellation").mockResolvedValueOnce(stored()).mockResolvedValueOnce({ ...stored(),
      jobReference: { ...jobReference, projectId: "other-project" } });
    const sendOnce = vi.fn();
    await expect(sendRequestedJobCancellation(access, "i", { getAccessToken: async () => "synthetic", sendOnce })).rejects.toThrow("unavailable");
    expect(sendOnce).not.toHaveBeenCalled();
  });
  it.each(["not-requested", "settled-unverified"] as const)("does not send when final state becomes %s", async state => {
    vi.spyOn(cancellation, "readJobCancellation").mockResolvedValueOnce(stored()).mockResolvedValueOnce({ jobReference, state, request: null });
    const sendOnce = vi.fn();
    expect(await sendRequestedJobCancellation(access, "i", { getAccessToken: async () => "synthetic", sendOnce }))
      .toEqual({ state: "not-sent", reason: state, jobReference });
    expect(sendOnce).not.toHaveBeenCalled();
  });
  it("sanitizes a failed final authority read without sending", async () => {
    vi.spyOn(cancellation, "readJobCancellation").mockResolvedValueOnce(stored()).mockRejectedValueOnce(new Error("private storage diagnostic"));
    const sendOnce = vi.fn();
    await expect(sendRequestedJobCancellation(access, "i", { getAccessToken: async () => "synthetic", sendOnce }))
      .rejects.toThrow(/^BigQuery cancellation transport unavailable$/);
    expect(sendOnce).not.toHaveBeenCalled();
  });
  it.each([
    { projectId: "../../other" }, { location: "US&other=1" }, { jobId: "caller-job" }
  ])("rejects an unsafe stored routing component before credentials: %j", async changed => {
    vi.spyOn(cancellation, "readJobCancellation").mockResolvedValue({ ...stored(), jobReference: { ...jobReference, ...changed } });
    const sendOnce = vi.fn(), getAccessToken = vi.fn();
    await expect(sendRequestedJobCancellation(access, "i", { getAccessToken, sendOnce })).rejects.toThrow("unavailable");
    expect(getAccessToken).not.toHaveBeenCalled(); expect(sendOnce).not.toHaveBeenCalled();
  });
  it("pins the tenant and principal across token preparation", async () => {
    const local = { ...access };
    const read = vi.spyOn(cancellation, "readJobCancellation").mockResolvedValue(stored());
    const sendOnce = vi.fn(async () => new Response(null));
    await sendRequestedJobCancellation(local, "i", { sendOnce, getAccessToken: async () => {
      local.tenantId = "other"; local.principalId = "other"; return "synthetic";
    } });
    expect(read).toHaveBeenCalledTimes(2);
    for (const [scope, intent] of read.mock.calls) { expect(scope).toEqual(access); expect(intent).toBe("i"); }
    expect(sendOnce).toHaveBeenCalledTimes(1);
  });
});
