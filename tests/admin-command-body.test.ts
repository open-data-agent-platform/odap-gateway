import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../worker";
import { SESSION_COOKIE, signAuthPayload } from "../lib/auth";
import { adminAuthority } from "./fixtures/admin-authority";
import { readAdminJsonBody } from "../lib/admin-command-request";

const routes = [
  ["users/target", "PATCH"], ["feature-flags/target", "PATCH"],
  ["schema-fields/target", "PATCH"], ["run-reviews/target", "PATCH"],
  ["docs-feedback/target", "PATCH"], ["schema-import", "POST"]
];
const secret = "synthetic-admin-body-secret";
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

async function fixture(path: string, method: string, body: BodyInit, headers: Record<string, string> = {}, signal?: AbortSignal,
  authMode = "admin") {
  const token = await signAuthPayload({ provider: "google", providerId: "123", email: "owner@example.com",
    name: "Fixture", role: authMode === "member" ? "member" : "admin", expiresAt: Date.now() + 60_000 }, secret);
  const authority = authMode === "revoked" ? adminAuthority("github", "revoked") : adminAuthority();
  const prepare = vi.fn(authority.prepare.bind(authority));
  if (authMode === "unavailable") prepare.mockImplementation(() => { throw new Error("Private authority failure"); });
  const outbound = vi.spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("Unexpected provider access"); });
  const request = new Request("https://gateway.test/gateway/api/admin/" + path, {
    method, body, duplex: "half", signal, headers: { Cookie: authMode === "anonymous" ? "" : SESSION_COOKIE + "=" + token,
      "Content-Type": "application/json", ...headers }
  } as RequestInit);
  const run = () => worker.fetch(request, { DB: { prepare }, AUTH_COOKIE_SECRET: authMode === "unconfigured" ? undefined : secret,
    GATEWAY_MODE: "production", GATEWAY_BASE_PATH: "/gateway",
    ASSETS: { fetch: async () => { throw new Error("Unexpected asset lookup"); } }
  }, { waitUntil() {} });
  return { request, run, prepare, outbound };
}

describe.each(routes)("admin body admission: %s", (path, method) => {
  it("refuses actual bytes above 16 KiB even with a dishonest length", async () => {
    const f = await fixture(path, method, " ".repeat(16383) + "{}", { "Content-Length": "2" });
    const response = await f.run();
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ ok: false, code: "admin_body_too_large" });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(f.prepare).toHaveBeenCalledTimes(1);
    expect(f.outbound).not.toHaveBeenCalled();
    expect(f.request.body?.locked).toBe(false);
  });

  it("refuses declared oversize without pulling or awaiting cancellation", async () => {
    const pull = vi.fn();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const body = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
    const f = await fixture(path, method, body, { "Content-Length": "16385" });
    const response = await f.run();
    expect(response.status).toBe(413);
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    expect(f.prepare).toHaveBeenCalledTimes(1);
    expect(f.outbound).not.toHaveBeenCalled();
    expect(body.locked).toBe(false);
  });

  it.each(["invalid-utf8", "array", "malformed", "aborted", "stream-error"])("rejects %s before mutation", async mode => {
    const abort = new AbortController();
    const body = mode === "invalid-utf8" ? new Uint8Array([123,34,120,34,58,34,255,34,125]) :
      mode === "stream-error" ? new ReadableStream({ pull(c) { c.error(new Error("Private stream failure")); } }) :
      mode === "array" ? "[]" : mode === "malformed" ? "{" : "{}";
    if (mode === "aborted") abort.abort(new Error("Private abort reason"));
    const f = await fixture(path, method, body, {}, abort.signal);
    const response = await f.run();
    expect(response.status).toBe(400);
    const value = await response.json();
    expect(value).toMatchObject({ ok: false, code: path.startsWith("feature-flags") ? "invalid_rollout" : "invalid_json" });
    expect(JSON.stringify(value)).not.toContain("Private");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(f.prepare).toHaveBeenCalledTimes(1);
    expect(f.outbound).not.toHaveBeenCalled();
    expect(f.request.body?.locked).toBe(false);
  });

  it("ends stalled body reads after one total deadline, without mutation", async () => {
    let started!: () => void;
    const reading = new Promise<void>(resolve => { started = resolve; });
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const body = new ReadableStream<Uint8Array>({ pull() { started(); }, cancel }, { highWaterMark: 0 });
    const f = await fixture(path, method, body);
    vi.useFakeTimers();
    const result = f.run();
    await reading;
    await vi.advanceTimersByTimeAsync(15_000);
    const response = await result;
    expect(response.status).toBe(408);
    expect(await response.json()).toMatchObject({ ok: false, code: "admin_body_timeout" });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
    expect(f.prepare).toHaveBeenCalledTimes(1);
    expect(f.outbound).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["unconfigured", "anonymous", "member", "revoked", "unavailable"])("keeps %s authorization ahead of body consumption", async mode => {
    const pull = vi.fn(), cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
    const f = await fixture(path, method, body, { "Content-Length": "999999" }, undefined, mode);
    const response = await f.run();
    expect(response.status).toBe(mode === "unavailable" ? 503 : ["member", "revoked"].includes(mode) ? 403 : 401);
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect(f.request.bodyUsed).toBe(false);
    expect(body.locked).toBe(false);
    expect(f.prepare).toHaveBeenCalledTimes(["revoked", "unavailable"].includes(mode) ? 1 : 0);
    expect(f.outbound).not.toHaveBeenCalled();
    await body.cancel();
  });
});

describe("administrator JSON envelope", () => {
  it("accepts an exact 16 KiB object and preserves its fields", async () => {
    const value = { role: "member", queryable: false, pii: true, rollout: 0, status: "pending", tableLimit: 100 };
    const json = JSON.stringify(value);
    expect(await readAdminJsonBody(new Request("https://gateway.test", { method: "POST",
      body: " ".repeat(16384 - json.length) + json }))).toEqual({ ok: true, value });
  });

  it("admits the maximum answer length even with six-byte JSON escapes", async () => {
    const body = '{"status":"approved","answerText":"' + "\\u4e00".repeat(1600) + '"}';
    expect(new TextEncoder().encode(body).length).toBeLessThan(16384);
    expect(await readAdminJsonBody(new Request("https://gateway.test", { method: "PATCH", body })))
      .toEqual({ ok: true, value: { status: "approved", answerText: "\u4e00".repeat(1600) } });
  });
});
