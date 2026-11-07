import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SESSION_COOKIE, signAuthPayload } from "../lib/auth";

const require = createRequire(import.meta.url);
const bundler = createRequire(require.resolve("wrangler/package.json"))("esbuild") as typeof import("esbuild");
const origin = "https://gateway.test";
let mf: Miniflare;
let cookie: string;

beforeAll(async () => {
  const bundle = await bundler.build({ bundle: true, write: false, format: "esm", platform: "browser",
    stdin: { resolveDir: resolve(__dirname, ".."), contents: `
      import worker from "./worker";
      export default { fetch(request) {
        return worker.fetch(request, {
          GATEWAY_BASE_PATH: new URL(request.url).pathname.startsWith("/gateway/") ? "/gateway" : "",
          GATEWAY_MODE: "production", AUTH_COOKIE_SECRET: "synthetic-native-logout",
          ASSETS: { fetch() { throw new Error("Unexpected asset access"); } },
          ODAP_GATEWAY_DB: { prepare() { throw new Error("Unexpected database access"); } }
        }, { waitUntil() { throw new Error("Unexpected background work"); } });
      }}
    ` } });
  const config = JSON.parse(readFileSync(resolve(__dirname, "../wrangler.example.jsonc"), "utf8"));
  mf = new Miniflare({ host: "127.0.0.1", port: 0, modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: config.compatibility_date, outboundService: () => { throw new Error("Unexpected network call"); } });
  cookie = SESSION_COOKIE + "=" + await signAuthPayload({ provider: "google", providerId: "fixture",
    email: "fixture@example.test", name: "Fixture", role: "member", expiresAt: Date.now() + 600000 }, "synthetic-native-logout");
}, 30000);
afterAll(async () => { await mf?.dispose(); });

describe.each(["", "/gateway"])("native logout at %s", base => {
  it.each(["GET", "HEAD"])("preserves the session on %s", async method => {
    const response = await mf.dispatchFetch(origin + base + "/api/auth/logout", { method, headers: { Cookie: cookie } });
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("POST");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Set-Cookie")).toBeNull();
    expect(response.headers.get("Location")).toBeNull();
    const session = await mf.dispatchFetch(origin + base + "/api/auth/session", { headers: { Cookie: cookie } });
    expect(await session.json()).toMatchObject({ authenticated: true });
  });

  it.each([undefined, "null", "https://other.test"])("rejects POST with Origin %s without a cookie change", async source => {
    const response = await mf.dispatchFetch(origin + base + "/api/auth/logout", { method: "POST",
      headers: { Cookie: cookie, ...(source ? { Origin: source } : {}) }, redirect: "manual" });
    expect(response.status).toBe(403);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Set-Cookie")).toBeNull();
    expect(response.headers.get("Location")).toBeNull();
    expect(await response.json()).toMatchObject({ code: "same_origin_required" });
  });

  it("clears the cookie with a same-origin POST and uses a mounted 303 login redirect", async () => {
    const response = await mf.dispatchFetch(origin + base + "/api/auth/logout", { method: "POST",
      headers: { Cookie: cookie, Origin: origin }, redirect: "manual" });
    expect(response.status).toBe(303);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Location")).toBe(origin + base + "/login?logout=1");
    expect(response.headers.get("Set-Cookie")).toBe(SESSION_COOKIE + "=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure");
    const session = await mf.dispatchFetch(origin + base + "/api/auth/session");
    expect(await session.json()).toMatchObject({ authenticated: false });
  });
});
