import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchOAuthJson } from "../lib/oauth-provider-json";

const limit = 256 * 1024;
const endpoint = "https://provider.example.test/profile";
const encoder = new TextEncoder();
const failure = "OAuth provider request failed";
const run = () => fetchOAuthJson(endpoint, { headers: { Authorization: "Bearer synthetic" } });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("bounded OAuth JSON transport", () => {
  it("accepts the exact byte ceiling and clears its timer after success", async () => {
    vi.useFakeTimers();
    const http = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(" ".repeat(limit - 2) + "{}"));
    expect(await run()).toEqual({});
    expect(http.mock.calls[0][1]?.redirect).toBe("manual");
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(http.mock.calls[0][1]?.signal?.aborted).toBe(false);
  });

  it.each([undefined, "1", "garbage"])("counts stream bytes independently of length %s", async length => {
    let pulls = 0;
    const cancel = vi.fn(() => Promise.reject(new Error("synthetic-private-cancel")));
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { pulls++; controller.enqueue(new Uint8Array(limit + 1).fill(32)); }, cancel
    }, { highWaterMark: 0 });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body, { headers: length ? { "Content-Length": length } : {} }));
    await expect(run()).rejects.toThrow(failure);
    expect(pulls).toBe(1);
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it("counts UTF-8 bytes rather than JavaScript characters", async () => {
    const payload = JSON.stringify("\u00e9".repeat(limit / 2));
    expect(payload.length).toBeLessThan(limit);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(payload));
    await expect(run()).rejects.toThrow(failure);
  });

  it("decodes valid UTF-8 split across chunks", async () => {
    const bytes = encoder.encode('{"name":"\u00e9"}');
    let index = 0;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new ReadableStream<Uint8Array>({
      pull(controller) { if (index < bytes.length) controller.enqueue(bytes.subarray(index, ++index)); else controller.close(); }
    })));
    expect(await run()).toEqual({ name: "\u00e9" });
  });

  it.each([new Uint8Array([34, 0xff, 34]), encoder.encode("synthetic-private-json"), new Uint8Array()])(
    "refuses invalid encoding, malformed or empty JSON (%j)", async bytes => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(bytes));
      await expect(run()).rejects.toEqual(new Error(failure));
    });

  it("rejects a missing body and clears its timer", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null));
    await expect(run()).rejects.toThrow(failure);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("discards late headers even when the mocked fetch ignores abort", async () => {
    vi.useFakeTimers();
    let arrive!: (response: Response) => void;
    const http = vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise<Response>(resolve => { arrive = resolve; }));
    const pending = expect(run()).rejects.toThrow(failure);
    await vi.advanceTimersByTimeAsync(15_000);
    await pending;
    const response = Response.json({ private: "synthetic" });
    const cancel = vi.spyOn(response.body!, "cancel");
    const read = vi.spyOn(response.body!, "getReader");
    arrive(response);
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledOnce();
    expect(read).not.toHaveBeenCalled();
    expect(http.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not extend the total request deadline when another body chunk arrives", async () => {
    vi.useFakeTimers();
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const body = new ReadableStream<Uint8Array>({ start(controller) { stream = controller; }, cancel });
    const http = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body));
    const pending = expect(run()).rejects.toThrow(failure);
    await vi.advanceTimersByTimeAsync(14_000);
    stream.enqueue(encoder.encode(" "));
    await vi.advanceTimersByTimeAsync(1_000);
    await pending;
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
    expect(http.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
