import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onRequest } from "../functions/api/auth/logout";
import { SESSION_COOKIE } from "../lib/auth";
import worker from "../worker";

const asset = vi.fn(async () => { throw new Error("Unexpected asset access"); });
const prepare = vi.fn(() => { throw new Error("Unexpected database access"); });
const outbound = vi.fn(async () => { throw new Error("Unexpected provider access"); });
const background = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", outbound);
});
afterEach(() => {
  for (const call of [asset, prepare, outbound, background]) expect(call).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe.each(["pages", "worker", "mounted-worker"])("logout: %s", surface => {
  const base = surface === "mounted-worker" ? "/gateway" : "";
  async function call(method: string, origin?: string, site = "https://gateway.test") {
    const headers = new Headers({ Cookie: SESSION_COOKIE + "=synthetic-session" });
    if (origin !== undefined) headers.set("Origin", origin);
    const request = new Request(site + base + "/api/auth/logout?returnTo=https://other.test", { method, headers });
    return surface === "pages" ? onRequest({ request }) :
      worker.fetch(request, { GATEWAY_BASE_PATH: base, GATEWAY_MODE: "production", ASSETS: { fetch: asset },
        ODAP_GATEWAY_DB: { prepare } }, { waitUntil: background });
  }

  it.each(["GET", "HEAD", "OPTIONS", "PUT", "DELETE"])("does not clear the session on %s", async method => {
    const response = await call(method, "https://gateway.test");
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("POST");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Set-Cookie")).toBeNull();
    expect(response.headers.get("Location")).toBeNull();
  });

  it.each([undefined, "null", "https://other.test", "https://gateway.test.other.test", "http://gateway.test",
    "https://gateway.test:8443", "https://gateway.test/"])("refuses untrusted Origin %s", async origin => {
    const response = await call("POST", origin);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ ok: false, code: "same_origin_required" });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Set-Cookie")).toBeNull();
    expect(response.headers.get("Location")).toBeNull();
  });

  it.each(["https://gateway.test", "http://localhost:8787"])("clears the cookie only for same-origin POST: %s", async site => {
    const response = await call("POST", site, site);
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe(site + base + "/login?logout=1");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const cookie = response.headers.get("Set-Cookie")!;
    expect(cookie).toContain(SESSION_COOKIE + "=;");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Max-Age=0");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie.includes("Secure")).toBe(site.startsWith("https:"));
  });
});
