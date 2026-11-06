import { afterEach, describe, expect, it, vi } from "vitest";
import { onRequestPost } from "../functions/api/docs/feedback";

const limit = 16 * 1024;
const encode = (value: string) => new TextEncoder().encode(value);
const trap = () => ({ prepare: vi.fn(() => { throw new Error("Unexpected feedback storage"); }) });
const request = (body: BodyInit | null, signal?: AbortSignal, length?: string) => new Request("https://gateway.test/api/docs/feedback", {
  method: "POST", body, signal, duplex: "half", headers: length ? { "Content-Length": length } : {}
} as RequestInit);
const post = (req: Request, db = trap()) => onRequestPost({ request: req, env: { DB: db } });

async function refusal(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  const body = await response.json();
  expect(body).toMatchObject({ ok: false, code });
  expect(JSON.stringify(body)).not.toContain("synthetic-private");
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("public feedback body admission", () => {
  it.each([undefined, "1", "invalid"])("rejects actual oversize despite declared length %s, before the honeypot", async length => {
    const db = trap();
    const response = await post(request(JSON.stringify({ company: "bot", ignored: "x".repeat(limit) }), undefined, length), db);
    await refusal(response, 413, "feedback_too_large");
    expect(db.prepare).not.toHaveBeenCalled();
  });

  it("rejects declared oversize without acquiring a reader", async () => {
    const req = request('{"company":"bot"}', undefined, String(limit + 1));
    const reader = vi.spyOn(req.body!, "getReader");
    await refusal(await post(req), 413, "feedback_too_large");
    expect(reader).not.toHaveBeenCalled();
  });

  it("accepts exactly the byte ceiling and preserves the non-persisted honeypot response", async () => {
    vi.useFakeTimers();
    const json = '{"company":"bot"}', req = request(" ".repeat(limit - json.length) + json);
    const response = await post(req);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ accepted: true, persisted: false, feedback: null });
    expect(req.body!.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses encoded bytes, not JavaScript string length", async () => {
    await refusal(await post(request(JSON.stringify({ company: "\u00e9".repeat(9000) }))), 413, "feedback_too_large");
  });

  it("allows a multibyte value split between chunks", async () => {
    const bytes = encode('{"company":"\u00e9"}');
    let offset = 0;
    const body = new ReadableStream<Uint8Array>({ pull(c) {
      if (offset < bytes.length) c.enqueue(bytes.subarray(offset, ++offset)); else c.close();
    } });
    expect((await post(request(body))).status).toBe(200);
    expect(body.locked).toBe(false);
  });

  it.each([null, "", "synthetic-private-json", "[]", "null", "42", '"text"'])("refuses non-object or malformed JSON %j", async body => {
    const db = trap();
    await refusal(await post(request(body), db), 400, "invalid_json");
    expect(db.prepare).not.toHaveBeenCalled();
  });

  it("rejects invalid UTF-8 rather than replacing it inside a valid JSON string", async () => {
    const body = new Uint8Array([...encode('{"company":"'), 255, ...encode('"}')]);
    await refusal(await post(request(body)), 400, "invalid_json");
  });

  it("rejects a previously aborted request even with a valid body", async () => {
    const abort = new AbortController();
    abort.abort(new Error("synthetic-private-abort"));
    await refusal(await post(request('{"company":"bot"}', abort.signal)), 400, "invalid_json");
  });

  it.each(["reject", "stall"])("does not await %s cancellation after exceeding the ceiling", async mode => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => mode === "reject" ? Promise.reject(new Error("synthetic-private-cancel")) : new Promise<void>(() => {}));
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(limit + 1)); }, cancel });
    let settled = false;
    const pending = post(request(body)).then(value => { settled = true; return value; });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);
    await refusal(await pending, 413, "feedback_too_large");
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("sanitizes stream errors without storage or retained locks", async () => {
    const body = new ReadableStream<Uint8Array>({ pull(c) { c.error(new Error("synthetic-private-stream")); } });
    await refusal(await post(request(body)), 400, "invalid_json");
    expect(body.locked).toBe(false);
  });

  it("refuses consumed or separately locked requests without taking ownership", async () => {
    const consumed = request('{"company":"bot"}');
    await consumed.text();
    await refusal(await post(consumed), 400, "invalid_json");
    const locked = request('{"company":"bot"}'), owner = locked.body!.getReader();
    try {
      await refusal(await post(locked), 400, "invalid_json");
      expect(locked.body!.locked).toBe(true);
      expect((await owner.read()).done).toBe(false);
    } finally { await owner.cancel(); owner.releaseLock(); }
  });

  it("preserves field validation for maximum-length escaped feedback without storage", async () => {
    const body = JSON.stringify({ kind: "question", topic: "\u00e9".repeat(120), authorName: "\u00e9".repeat(80),
      authorEmail: "reader@example.test", message: "\u00e9".repeat(1200), company: "" }).replaceAll("\u00e9", "\\u00e9");
    expect(encode(body).length).toBeLessThan(limit);
    const response = await onRequestPost({ request: request(body), env: {} });
    await refusal(response, 503, "docs_feedback_storage_unavailable");
  });

  it.each(["stall", "late-chunk", "abort"])("ends %s without waiting for cancellation or touching storage", async mode => {
    vi.useFakeTimers();
    const db = trap(), abort = new AbortController();
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const body = new ReadableStream<Uint8Array>({ start(c) { stream = c; }, cancel });
    const req = request(body, abort.signal), remove = vi.spyOn(req.signal, "removeEventListener");
    let settled = false;
    const pending = post(req, db).then(value => { settled = true; return value; });
    try {
      if (mode === "abort") abort.abort(new Error("synthetic-private-abort"));
      else {
        await vi.advanceTimersByTimeAsync(14_000);
        expect(settled).toBe(false);
        if (mode === "late-chunk") stream.enqueue(encode('{"company":"bot"}'));
      }
      await vi.advanceTimersByTimeAsync(mode === "abort" ? 0 : 1000);
      expect(settled).toBe(true);
      await refusal(await pending, mode === "abort" ? 400 : 408, mode === "abort" ? "invalid_json" : "feedback_timeout");
      expect(cancel).toHaveBeenCalledOnce();
      expect(body.locked).toBe(false);
      expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
      expect(vi.getTimerCount()).toBe(0);
      expect(db.prepare).not.toHaveBeenCalled();
    } finally {
      if (!cancel.mock.calls.length) stream.close();
      await pending;
    }
  });
});
