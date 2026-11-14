import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../worker";
import type { D1PreparedStatement } from "../lib/d1";
import { SESSION_COOKIE, signAuthPayload, type AuthSession } from "../lib/auth";
import { recoveryCookie, recoveryEnv } from "./fixtures/delegated-recovery-request-cases";

afterEach(() => vi.restoreAllMocks());

describe("cancellation command admission", () => {
  function storage(role: string | null = "owner") {
    const statement: D1PreparedStatement = { bind: () => statement, first: async <T>() => role === null ? null : { role } as T,
      all: async () => { throw new Error("Unexpected command storage"); }, run: async () => { throw new Error("Unexpected command write"); } };
    const prepare = vi.fn((sql: string) => {
      if (!sql.startsWith("SELECT role FROM control_memberships")) throw new Error("Unexpected command storage");
      return statement;
    });
    return { prepare };
  }
  async function call(body: unknown = { intentId: "intent" }, options: {
    method?: string; tenant?: string; query?: string; origin?: string; contentType?: string; cookie?: string; role?: string | null; audience?: string
  } = {}) {
    const db = storage(options.role), method = options.method ?? "POST";
    const headers = new Headers({ Origin: options.origin ?? "https://gateway.test", "Content-Type": options.contentType ?? "application/json",
      Cookie: options.cookie ?? await recoveryCookie(), "X-Tenant-Id": "t", "X-Role": "owner", "X-Principal-Id": "google:operator" });
    const request = new Request("https://gateway.test/gateway/api/control/"+(options.tenant ?? "t")+"/cancellation-requests"+(options.query ?? ""), {
      method, headers, ...(!["GET", "HEAD"].includes(method) && { body: JSON.stringify(body) })
    });
    const response = await worker.fetch(request, { ...recoveryEnv(db, options.audience), GATEWAY_BASE_PATH: "/gateway" }, { waitUntil() {} });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    return { response, db, body: await response.json() };
  }
  it.each(["GET", "PUT", "PATCH", "DELETE", "OPTIONS"])("rejects %s before storage", async method => {
    const r = await call({}, { method }); expect(r.response.status).toBe(405);
    expect(r.response.headers.get("Allow")).toBe("POST"); expect(r.db.prepare).not.toHaveBeenCalled();
  });
  it.each(["?send=true", "?audience=other", "?intentId=intent"])("rejects query options %s before storage", async query => {
    const r = await call({}, { query }); expect(r.response.status).toBe(400);
    expect(r.body).toEqual({ ok: false, code: "invalid_cancellation_request" }); expect(r.db.prepare).not.toHaveBeenCalled();
  });
  it.each(["", "null", "https://other.test"])("requires exact same origin %s", async origin => {
    const r = await call({}, { origin }); expect(r.response.status).toBe(403);
    expect(r.body).toEqual({ ok: false, code: "same_origin_required" }); expect(r.db.prepare).not.toHaveBeenCalled();
  });
  it.each(["text/plain", "application/x-www-form-urlencoded"])("rejects content type %s", async contentType => {
    const r = await call({}, { contentType }); expect(r.response.status).toBe(415); expect(r.db.prepare).not.toHaveBeenCalled();
  });
  it.each(["bad!", "t%2Fpeer", "t%00", "x".repeat(129)])("rejects malformed tenant %#", async tenant => {
    const r = await call({}, { tenant }); expect(r.response.status).toBe(400); expect(r.db.prepare).not.toHaveBeenCalled();
  });
  it.each(["missing", "expired", "tampered", "oauth-state", "email-only"])("rejects %s identity before storage", async kind => {
    const cookie = kind === "missing" ? "" : kind === "expired" ? await recoveryCookie("operator", Date.now()-1000) :
      kind === "tampered" ? (await recoveryCookie())+"x" : SESSION_COOKIE+"="+await signAuthPayload(kind === "oauth-state"
        ? { provider: "google", nonce: "fixture", returnTo: "/", expiresAt: Date.now()+60000 }
        : { provider: "google", email: "owner@example.test", role: "admin", expiresAt: Date.now()+60000 } as AuthSession, "recovery-read-synthetic-cookie-key");
    const r = await call({}, { cookie }); expect(r.response.status).toBe(401);
    expect(r.body).toEqual({ ok: false, code: "unauthenticated" }); expect(r.db.prepare).not.toHaveBeenCalled();
  });
  it.each(["reader", "reviewer", null])("rejects non-owner %s despite global admin and headers", async role => {
    const r = await call({}, { role }); expect(r.response.status).toBe(403); expect(r.db.prepare).toHaveBeenCalledTimes(1);
  });
  it.each(["", "bad audience"])("requires configured audience %j", async audience => {
    const r = await call({}, { audience }); expect(r.response.status).toBe(503);
    expect(r.body).toEqual({ ok: false, code: "delegation_not_configured" }); expect(r.db.prepare).toHaveBeenCalledTimes(1);
  });
  it.each([null, [], {}, { intentId: 1 }, { intentId: "" }, { intentId: "bad!" }, { intentId: "a/b" }, { intentId: "x".repeat(129) }])
    ("rejects malformed body %# before command storage", async body => {
      const r = await call(body); expect(r.response.status).toBe(400);
      expect(r.body).toEqual({ ok: false, code: "invalid_cancellation_request" }); expect(r.db.prepare).toHaveBeenCalledTimes(1);
    });
  it.each(["tenantId", "principalId", "audience", "jobId", "requestedBy", "send", "releaseBudget", "cancellationConfirmed"])
    ("rejects caller-supplied %s", async field => {
      const r = await call({ intentId: "intent", [field]: "injected" }); expect(r.response.status).toBe(400);
      expect(r.body).toEqual({ ok: false, code: "invalid_cancellation_request" }); expect(r.db.prepare).toHaveBeenCalledTimes(1);
    });
});
