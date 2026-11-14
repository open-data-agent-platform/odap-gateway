import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../worker";
import { requestDispatchStop } from "../lib/dispatch-stop-request";
import type { D1PreparedStatement } from "../lib/d1";
import { SESSION_COOKIE, signAuthPayload, type AuthSession } from "../lib/auth";
import { recoveryCookie, recoveryEnv } from "./fixtures/delegated-recovery-request-cases";

afterEach(() => vi.restoreAllMocks());
const empty = { claimed: null, settled: null, stopped: null, actor: null, at: null };
describe("pre-dispatch stop read admission", () => {
  async function call(options: { method?: string; tenant?: string; id?: string; query?: string; cookie?: string;
    role?: string | null; stored?: unknown; noDatabase?: boolean } = {}) {
    const prepare = vi.fn((sql: string) => {
      if (!sql.startsWith("SELECT ")) throw new Error("No writes allowed");
      const s: D1PreparedStatement = { bind: () => s, first: async<T>() =>
        (sql.startsWith("SELECT role") ? options.role === null ? null : { role: options.role ?? "owner" }
          : options.stored === undefined ? empty : options.stored) as T,
        all: async () => { throw new Error("Unexpected bulk read"); },
        run: async () => { throw new Error("No writes allowed"); } };
      return s;
    });
    const db = { prepare }, request = new Request("https://gateway.test/gateway/api/control/"+(options.tenant ?? "t")+
      "/dispatch-stops/"+(options.id ?? "i")+(options.query ?? ""), { method: options.method ?? "GET",
      headers: { Cookie: options.cookie ?? await recoveryCookie(), "X-Tenant-Id": "t", "X-Role": "owner" } });
    const response = await worker.fetch(request, { ...recoveryEnv(db), ODAP_DELEGATION_AUDIENCE: undefined,
      DB: options.noDatabase ? undefined : db, GATEWAY_BASE_PATH: "/gateway" }, { waitUntil() {} });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    return { response, body: await response.json(), prepare };
  }
  it.each(["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"])("rejects %s before storage", async method => {
    const r = await call({ method }); expect(r.response.status).toBe(405);
    expect(r.response.headers.get("Allow")).toBe("GET"); expect(r.prepare).not.toHaveBeenCalled();
  });
  it.each(["?stop=true", "?refresh=true", "?tenant=other"])("rejects query %s before storage", async query => {
    const r = await call({ query }); expect(r.response.status).toBe(400);
    expect(r.body).toEqual({ ok: false, code: "invalid_dispatch_stop_view" }); expect(r.prepare).not.toHaveBeenCalled();
  });
  it.each(["bad!", "t%2Fpeer", "t%00", "x".repeat(129)])("rejects malformed path %#", async value => {
    for (const options of [{ tenant: value }, { id: value }]) {
      const r = await call(options); expect(r.response.status).toBe(400); expect(r.prepare).not.toHaveBeenCalled();
    }
  });
  it.each([null, {}, 1])("shared policy rejects non-string scope %#", async value => {
    const r = await requestDispatchStop(new Request("https://gateway.test"), {}, value, "i");
    expect(r).toEqual({ status: 400, body: { ok: false, code: "invalid_control_path" } });
  });
  it.each(["missing", "expired", "tampered", "oauth-state", "email-only"])("rejects %s identity", async kind => {
    const cookie = kind === "missing" ? "" : kind === "expired" ? await recoveryCookie("operator",Date.now()-1000) :
      kind === "tampered" ? (await recoveryCookie())+"x" : SESSION_COOKIE+"="+await signAuthPayload(kind === "oauth-state"
        ? { provider: "google", nonce: "fixture", returnTo: "/", expiresAt: Date.now()+60000 }
        : { provider: "google", email: "owner@example.test", role: "admin", expiresAt: Date.now()+60000 } as AuthSession,
      "recovery-read-synthetic-cookie-key");
    const r = await call({ cookie }); expect(r.response.status).toBe(401);
    expect(r.body).toEqual({ ok: false, code: "unauthenticated" }); expect(r.prepare).not.toHaveBeenCalled();
  });
  it.each(["reader", "reviewer", null])("rejects non-owner %s despite global admin", async role => {
    const r = await call({ role }); expect(r.response.status).toBe(403); expect(r.prepare).toHaveBeenCalledTimes(1);
  });
  it("refuses absent storage without initialization", async () => {
    const r = await call({ noDatabase: true }); expect(r.response.status).toBe(503); expect(r.prepare).not.toHaveBeenCalled();
  });
  it("does not treat absent state as execution authority or require audience", async () => {
    const r = await call(); expect(r.response.status).toBe(200);
    expect(r.body).toEqual({ ok: true, dispatchStop: { tenantId: "t", intentId: "i", state: "not-stopped",
      source: "stored-evidence", scope: "local-dispatch-stop", providerContacted: false, cancellationConfirmed: false,
      executionAuthorized: false, settlementAuthorized: false } }); expect(r.prepare).toHaveBeenCalledTimes(2);
  });
  it("does not disclose an absent owner-scoped row", async () => {
    const r = await call({ stored: null }); expect(r.response.status).toBe(403);
    expect(r.body).toEqual({ ok: false, code: "tenant_access_denied" });
  });
  it.each([{}, { ...empty, claimed: "foreign" }, { ...empty, settled: 1 }, { ...empty, stopped: "other" },
    { ...empty, actor: "orphan" }, { ...empty, stopped: "i", actor: "owner" },
    { ...empty, stopped: "i", actor: " ", at: "2026-01-01T00:00:00.000Z" },
    { ...empty, stopped: "i", actor: "owner", at: "2026-02-30T00:00:00.000Z" }])
    ("sanitizes malformed stored row %#", async stored => {
      const r = await call({ stored }); expect(r.response.status).toBe(503);
      expect(r.body).toEqual({ ok: false, code: "control_storage_unavailable" });
    });
});
