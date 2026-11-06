import { afterEach, describe, expect, it, vi } from "vitest";
import { readCommandBody } from "../lib/control-command-request";

const encode = (value: string) => new TextEncoder().encode(value);
const request = (body: BodyInit | null, signal?: AbortSignal, length?: string) => new Request("https://gateway.test/command", {
  method: "POST", body, signal, duplex: "half", headers: length ? { "Content-Length": length } : {}
} as RequestInit);
const read = (body: BodyInit | null, signal?: AbortSignal, length?: string) => readCommandBody(request(body, signal, length), 64, "proposal");
async function refusal(result: Awaited<ReturnType<typeof read>>, status: number, code: string) {
  expect(result).toBeInstanceOf(Response);
  const response = result as Response;
  expect(response.status).toBe(status);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(await response.json()).toEqual({ ok: false, code });
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("bounded control command body", () => {
  it("accepts exactly the byte ceiling and releases timer and signal listener", async () => {
    vi.useFakeTimers();
    const abort = new AbortController(), req = request(" ".repeat(62) + "{}", abort.signal);
    const remove = vi.spyOn(req.signal, "removeEventListener");
    expect(await readCommandBody(req, 64, "proposal")).toEqual({ data: {} });
    expect(req.body!.locked).toBe(false);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
    abort.abort();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([undefined, "1", "invalid"])("counts actual bytes independently of length %s", async length => {
    const cancel = vi.fn(() => Promise.reject(new Error("synthetic-private-cancel")));
    const body = new ReadableStream<Uint8Array>({ pull(c) { c.enqueue(new Uint8Array(65)); }, cancel }, { highWaterMark: 0 });
    await refusal(await read(body, undefined, length), 413, "proposal_too_large");
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it("does not wait for stream cancellation before rejecting excessive bytes", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(65)); }, cancel });
    let settled = false;
    const pending = read(body).then(value => { settled = true; return value; });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);
    await refusal(await pending, 413, "proposal_too_large");
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels declared oversize without acquiring a reader or pulling data", async () => {
    const cancel = vi.fn(), pull = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
    const req = request(body, undefined, "65"), reader = vi.spyOn(req.body!, "getReader");
    await refusal(await readCommandBody(req, 64, "proposal"), 413, "proposal_too_large");
    expect(reader).not.toHaveBeenCalled();
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("uses encoded byte length and accepts a multibyte character split across chunks", async () => {
    await refusal(await read(JSON.stringify("\u00e9".repeat(32))), 413, "proposal_too_large");
    const bytes = encode('{"name":"\u00e9"}');
    let offset = 0;
    const body = new ReadableStream<Uint8Array>({ pull(c) {
      if (offset < bytes.length) c.enqueue(bytes.subarray(offset, ++offset)); else c.close();
    } });
    expect(await read(body)).toEqual({ data: { name: "\u00e9" } });
  });

  it.each([null, "", "synthetic-private-json", new Uint8Array([34, 0xff, 34])])("sanitizes malformed JSON %j", async body => {
    vi.useFakeTimers();
    await refusal(await read(body), 400, "invalid_proposal");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("sanitizes stream errors and releases the reader", async () => {
    const body = new ReadableStream<Uint8Array>({ pull(c) { c.error(new Error("synthetic-private-stream")); } });
    await refusal(await read(body), 400, "invalid_proposal");
    expect(body.locked).toBe(false);
  });

  it("rejects a previously aborted request even when a valid body is available", async () => {
    const abort = new AbortController();
    abort.abort(new Error("synthetic-private-abort"));
    await refusal(await read("{}", abort.signal), 400, "invalid_proposal");
  });

  it("stops a pending read on caller abort without waiting for cancellation", async () => {
    vi.useFakeTimers();
    const abort = new AbortController(), cancel = vi.fn(() => new Promise<void>(() => {}));
    const body = new ReadableStream<Uint8Array>({ cancel });
    let settled = false;
    const pending = read(body, abort.signal).then(value => { settled = true; return value; });
    abort.abort(new Error("synthetic-private-abort"));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);
    await refusal(await pending, 400, "invalid_proposal");
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])("applies one total deadline even with a late chunk=%s", async lateChunk => {
    vi.useFakeTimers();
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const body = new ReadableStream<Uint8Array>({ start(c) { stream = c; }, cancel });
    let settled = false;
    const pending = read(body).then(value => { settled = true; return value; });
    await vi.advanceTimersByTimeAsync(14_000);
    expect(settled).toBe(false);
    if (lateChunk) stream.enqueue(encode("{}"));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(settled).toBe(true);
    await refusal(await pending, 408, "proposal_timeout");
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
