import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runBigQueryDryRun, runBigQueryQuery } from "../lib/bigquery";

const limit = 256 * 1024;
const env = { GATEWAY_MODE: "demo" as const, BIGQUERY_PROJECT_ID: "fixture-project",
  BIGQUERY_CLIENT_EMAIL: "fixture@example.test", BIGQUERY_PRIVATE_KEY:
    generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs8" }).toString() };
const payload = JSON.stringify({ statistics: { totalBytesProcessed: "17" }, jobComplete: true,
  totalRows: "1", schema: { fields: [{ name: "n" }] }, rows: [{ f: [{ v: "17" }] }] });

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe.each(["dry-run", "query"] as const)("bounded legacy %s response", operation => {
  const run = () => operation === "dry-run" ? runBigQueryDryRun("SELECT 1", env) : runBigQueryQuery("SELECT 1", env);
  const failed = () => operation === "dry-run"
    ? { mode: "live", status: "blocked", error: { code: "bigquery_request_failed", message: "BigQuery request failed." } }
    : { ok: false, code: "bigquery_query_failed", message: "BigQuery query failed." };
  const success = () => operation === "dry-run" ? { mode: "live", scannedBytes: 17 }
    : { ok: true, totalRows: 1, rows: [{ n: "17" }] };

  function warehouse(send: (init: RequestInit) => Promise<Response>) {
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const http = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      if (String(url) === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "synthetic-token" });
      entered();
      return send(init!);
    });
    return { http, ready };
  }

  it("accepts the exact byte ceiling and clears the deadline", async () => {
    vi.useFakeTimers();
    const { http } = warehouse(async () => new Response(" ".repeat(limit - payload.length) + payload));
    expect(await run()).toMatchObject(success());
    expect(http).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([undefined, "1", "invalid"])("counts actual bytes with Content-Length %s", async length => {
    const response = new Response(" ".repeat(limit + 1 - payload.length) + payload,
      { headers: length ? { "Content-Length": length } : {} });
    const { http } = warehouse(async () => response);
    expect(await run()).toMatchObject(failed());
    expect(http).toHaveBeenCalledTimes(2);
    expect(response.body!.locked).toBe(false);
  });

  it("rejects a declared excess before acquiring a reader", async () => {
    const response = new Response(payload, { headers: { "Content-Length": String(limit + 1) } });
    const reader = vi.spyOn(response.body!, "getReader"), cancel = vi.spyOn(response.body!, "cancel");
    warehouse(async () => response);
    expect(await run()).toMatchObject(failed());
    expect(reader).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("counts UTF-8 bytes rather than characters", async () => {
    const body = payload.slice(0, -1) + ',"unused":"' + "\u00e9".repeat(limit / 2) + '"}';
    expect(body.length).toBeLessThan(limit);
    warehouse(async () => new Response(body));
    expect(await run()).toMatchObject(failed());
  });

  it("rejects invalid UTF-8 in an unused field", async () => {
    const prefix = new TextEncoder().encode(payload.slice(0, -1) + ',"unused":"');
    const bytes = new Uint8Array([...prefix, 0xff, 34, 125]);
    warehouse(async () => new Response(bytes));
    expect(await run()).toMatchObject(failed());
  });

  it("cancels excess streamed bytes without waiting for cancellation", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const response = new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(" ".repeat(limit)));
      controller.enqueue(new TextEncoder().encode(payload));
      controller.enqueue(new TextEncoder().encode(" "));
      controller.close();
    }, cancel }));
    warehouse(async () => response);
    expect(await run()).toMatchObject(failed());
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body!.locked).toBe(false);
  });

  it.each([null, false, [], "synthetic"])("refuses non-object JSON %j", async value => {
    warehouse(async () => Response.json(value));
    expect(await run()).toMatchObject(failed());
  });

  it("bounds stalled headers and discards a late success without retry", async () => {
    vi.useFakeTimers();
    let arrive!: (response: Response) => void, settled = false;
    const { http, ready } = warehouse(() => new Promise(resolve => { arrive = resolve; }));
    const pending = run().then(result => { settled = true; return result; });
    const response = new Response(payload);
    const reader = vi.spyOn(response.body!, "getReader"), cancel = vi.spyOn(response.body!, "cancel");
    try {
      await ready;
      await vi.advanceTimersByTimeAsync(15_000);
      expect(settled).toBe(true);
      expect(await pending).toMatchObject(failed());
      expect(http.mock.calls[1][1]?.signal?.aborted).toBe(true);
      arrive(response);
      await vi.advanceTimersByTimeAsync(0);
      expect(reader).not.toHaveBeenCalled();
      expect(cancel).toHaveBeenCalledOnce();
      expect(http).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally { arrive(response); await pending; }
  });

  it("shares one deadline between headers and a stalled body", async () => {
    vi.useFakeTimers();
    let stream!: ReadableStreamDefaultController<Uint8Array>, settled = false;
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const body = new ReadableStream<Uint8Array>({ start(controller) { stream = controller; }, cancel });
    const { http, ready } = warehouse(() => new Promise(resolve => {
      setTimeout(() => resolve(new Response(body)), 10_000);
    }));
    const pending = run().then(result => { settled = true; return result; });
    try {
      await ready;
      await vi.advanceTimersByTimeAsync(14_000);
      stream.enqueue(new TextEncoder().encode(" "));
      await vi.advanceTimersByTimeAsync(1_000);
      expect(settled).toBe(true);
      expect(await pending).toMatchObject(failed());
      expect(cancel).toHaveBeenCalledOnce();
      expect(body.locked).toBe(false);
      expect(http).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally { stream.error(new Error("fixture cleanup")); await pending; }
  });
});
