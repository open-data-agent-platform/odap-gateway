import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionCookie, signAuthPayload } from "../lib/auth";
import type { BigQueryEnv } from "../lib/bigquery";
import type { D1Database } from "../lib/d1";
import worker from "../worker";

const limit = 128 * 1024;
const secret = "synthetic-dry-run-body-session";
const credentials = { BIGQUERY_PROJECT_ID: "fixture-project", BIGQUERY_CLIENT_EMAIL: "fixture@example.test",
  BIGQUERY_PRIVATE_KEY: "synthetic-unused-key" };
const encode = (value: string) => new TextEncoder().encode(value);
let cookie: string;
const trap = () => ({ prepare: vi.fn(() => { throw new Error("Unexpected catalog/history access"); }),
  batch: vi.fn(async () => { throw new Error("Unexpected history transaction"); }) });
const request = (body: BodyInit | null, signal?: AbortSignal, length?: string, signed = true) => new Request(
  "https://gateway.test/gateway/api/query/dry-run", { method: "POST", body, signal, duplex: "half",
    headers: { Cookie: signed ? cookie : "", ...(length === undefined ? {} : { "Content-Length": length }) }
  } as RequestInit);
const post = (req: Request, db: D1Database | undefined = trap(), env: BigQueryEnv = { GATEWAY_MODE: "demo", ...credentials }) =>
  worker.fetch(req, { ...env, AUTH_COOKIE_SECRET: secret, GATEWAY_BASE_PATH: "/gateway", DB: db,
    ASSETS: { fetch: async () => { throw new Error("Unexpected asset lookup"); } } }, { waitUntil: () => undefined });

async function refusal(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  const body = await response.json();
  expect(body).toMatchObject({ ok: false, code });
  expect(JSON.stringify(body)).not.toContain("synthetic-private");
}

beforeAll(async () => {
  cookie = createSessionCookie(await signAuthPayload({ provider: "google", providerId: "fixture", role: "member",
    email: "fixture@example.test", name: "Fixture", expiresAt: Date.now() + 600000 }, secret));
});
beforeEach(() => { vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected provider call"); })); });
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("dry-run body admission", () => {
  it.each([undefined, "1", "invalid"])("rejects actual oversize despite declared length %s", async length => {
    const db = trap();
    await refusal(await post(request(JSON.stringify({ ignored: "x".repeat(limit) }), undefined, length), db),
      413, "dry_run_body_too_large");
    expect(db.prepare).not.toHaveBeenCalled();
    expect(db.batch).not.toHaveBeenCalled();
  });

  it("rejects declared oversize without reading or awaiting cancellation", async () => {
    const pull = vi.fn(), cancel = vi.fn(() => new Promise<void>(() => {}));
    const body = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
    const req = request(body, undefined, String(limit + 1)), reader = vi.spyOn(req.body!, "getReader");
    await refusal(await post(req), 413, "dry_run_body_too_large");
    expect(reader).not.toHaveBeenCalled();
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("counts encoded bytes rather than JavaScript characters", async () => {
    await refusal(await post(request(JSON.stringify({ ignored: "\u00e9".repeat(limit / 2) }))), 413, "dry_run_body_too_large");
  });

  it("preserves validation at exactly the byte ceiling", async () => {
    vi.useFakeTimers();
    const req = request(" ".repeat(limit - 2) + "{}");
    await refusal(await post(req), 400, "sql_required");
    expect(req.body!.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([null, "", "synthetic-private-json", "[]", "null", "42", '"text"'])("rejects malformed/non-object body %j", async body => {
    const db = trap();
    await refusal(await post(request(body), db), 400, "invalid_json");
    expect(db.prepare).not.toHaveBeenCalled();
    expect(db.batch).not.toHaveBeenCalled();
  });

  it("refuses invalid UTF-8 rather than replacing it", async () => {
    await refusal(await post(request(new Uint8Array([...encode('{"sql":"'), 255, ...encode('"}')]))), 400, "invalid_json");
  });

  it("retains the 20,000-character SQL limit after body decoding", async () => {
    await refusal(await post(request(JSON.stringify({ sql: "x".repeat(20001) }))), 400, "sql_too_large");
  });

  it("allows maximum-length SQL with six-byte JSON escapes through the existing simulated path", async () => {
    const sql = "SELECT order_id FROM `demo.orders` WHERE order_date >= CURRENT_DATE(); --".padEnd(20000, "x");
    const escaped = [...sql].map(char => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0")).join("");
    const payload = '{"sql":"' + escaped + '","workspace":"demo","queryType":"Escaped limit"}';
    expect(encode(payload).length).toBeLessThan(limit);
    const response = await worker.fetch(request(payload), { GATEWAY_MODE: "demo",
      GATEWAY_BASE_PATH: "/gateway", ASSETS: { fetch: async () => { throw new Error("Unexpected assets"); } }
    }, { waitUntil: () => undefined });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, persisted: false, preview: { mode: "simulated" } });
  });

  it("decodes a multibyte value split across chunks without altering field validation", async () => {
    const bytes = encode('{"ignored":"\u00e9"}');
    let offset = 0;
    const body = new ReadableStream<Uint8Array>({ pull(c) {
      if (offset < bytes.length) c.enqueue(bytes.subarray(offset, ++offset)); else c.close();
    } });
    await refusal(await post(request(body)), 400, "sql_required");
    expect(body.locked).toBe(false);
  });

  it.each(["abort", "stream-error", "consumed", "locked"])("refuses %s without catalog/history work", async mode => {
    const db = trap(), abort = new AbortController();
    if (mode === "abort") abort.abort(new Error("synthetic-private-abort"));
    const body = mode === "stream-error" ? new ReadableStream<Uint8Array>({ pull(c) {
      c.error(new Error("synthetic-private-stream"));
    } }) : "{}";
    const req = request(body, abort.signal);
    if (mode === "consumed") await req.text();
    const owner = mode === "locked" ? req.body!.getReader() : undefined;
    const priorLock = req.body!.locked;
    try {
      await refusal(await post(req, db), 400, "invalid_json");
      expect(req.body!.locked).toBe(priorLock);
      expect(db.prepare).not.toHaveBeenCalled();
      expect(db.batch).not.toHaveBeenCalled();
    } finally { await owner?.cancel(); owner?.releaseLock(); }
  });

  it.each(["stall", "late-chunk", "abort"])("bounds %s with one deadline and no downstream work", async mode => {
    vi.useFakeTimers();
    const db = trap(), abort = new AbortController();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let started!: () => void;
    const reading = new Promise<void>(resolve => { started = resolve; });
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; }, pull() { started(); }, cancel },
      { highWaterMark: 0 });
    let settled = false;
    const pending = post(request(body, abort.signal), db, {}).then(value => { settled = true; return value; });
    try {
      // Native WebCrypto is not advanced by fake timers; wait for authenticated body admission.
      await reading;
      expect(vi.getTimerCount()).toBe(1);
      if (mode === "abort") abort.abort(new Error("synthetic-private-abort"));
      else {
        await vi.advanceTimersByTimeAsync(14000);
        expect(settled).toBe(false);
        if (mode === "late-chunk") controller.enqueue(encode("{}"));
      }
      await vi.advanceTimersByTimeAsync(mode === "abort" ? 0 : 1000);
      expect(settled).toBe(true);
      await refusal(await pending, mode === "abort" ? 400 : 408, mode === "abort" ? "invalid_json" : "dry_run_body_timeout");
      expect(cancel).toHaveBeenCalledOnce();
      expect(body.locked).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      expect(db.prepare).not.toHaveBeenCalled();
      expect(db.batch).not.toHaveBeenCalled();
    } finally { if (!cancel.mock.calls.length) controller.close(); await pending; }
  });

  it("starts the body deadline only after delayed native session verification completes", async () => {
    vi.useFakeTimers();
    let release!: () => void, verifying!: () => void, started!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const authentication = new Promise<void>(resolve => { verifying = resolve; });
    const reading = new Promise<void>(resolve => { started = resolve; });
    const sign = crypto.subtle.sign.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "sign").mockImplementation(async (...args) => {
      verifying();
      await blocked;
      return sign(...args);
    });
    const db = trap(), cancel = vi.fn(() => new Promise<void>(() => {}));
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const pull = vi.fn(() => { started(); });
    const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; }, pull, cancel }, { highWaterMark: 0 });
    let settled = false;
    const pending = post(request(body), db, {}).then(value => { settled = true; return value; });
    try {
      await authentication;
      await vi.advanceTimersByTimeAsync(14000);
      expect(pull).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      expect(settled).toBe(false);
      release();
      await reading;
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(14999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
      await refusal(await pending, 408, "dry_run_body_timeout");
      expect(cancel).toHaveBeenCalledOnce();
      expect(body.locked).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      expect(db.prepare).not.toHaveBeenCalled();
      expect(db.batch).not.toHaveBeenCalled();
    } finally { release(); if (!cancel.mock.calls.length) controller.close(); await pending; }
  });

  it.each([
    { name: "anonymous production", env: { GATEWAY_MODE: "production" }, signed: false, status: 401, code: "unauthenticated" },
    { name: "anonymous live demo", env: { GATEWAY_MODE: "demo", ...credentials }, signed: false, status: 401, code: "unauthenticated" },
    { name: "production raw SQL", env: { GATEWAY_MODE: "production", ...credentials }, signed: true, status: 403, code: "production_preview_scope_unbound" },
    { name: "missing production configuration", env: { GATEWAY_MODE: "production" }, signed: true, status: 503, code: "production_not_configured" },
    { name: "implicit live mode", env: credentials, signed: true, status: 503, code: "gateway_mode_required" },
    { name: "missing transaction capability", env: {}, signed: false, status: 503, code: "dry_run_history_transaction_unavailable", brokenBatch: true }
  ])("keeps $name refusal before acquiring or pulling the body", async test => {
    const db = trap(), pull = vi.fn(), cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
    const req = request(body, undefined, String(limit + 1), test.signed);
    const reader = vi.spyOn(req.body!, "getReader");
    if (test.brokenBatch) Object.assign(db, { batch: undefined });
    await refusal(await post(req, db, test.env as BigQueryEnv), test.status, test.code);
    expect(reader).not.toHaveBeenCalled();
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect(req.bodyUsed).toBe(false);
    expect(db.prepare).not.toHaveBeenCalled();
    await body.cancel();
  });
});
