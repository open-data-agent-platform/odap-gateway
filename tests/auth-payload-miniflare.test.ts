import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Miniflare, Response as NativeResponse } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SESSION_COOKIE, signAuthPayload, type AuthSession } from "../lib/auth";

const require = createRequire(import.meta.url);
const bundler = createRequire(require.resolve("wrangler/package.json"))("esbuild") as typeof import("esbuild");
const secret = "synthetic-native-auth-boundary";
let mf: Miniflare;
let assetCalls = 0;
let outboundCalls = 0;

describe("authentication payload admission in installed Workers", () => {
  beforeAll(async () => {
    const bundle = await bundler.build({ bundle: true, write: false, format: "esm", platform: "browser",
      stdin: { resolveDir: resolve(__dirname, ".."), contents: `
        import worker from "./worker";
        export default {fetch(request,env,context) {
          return worker.fetch(request,{...env,DB:{prepare() {throw new Error("Unexpected database access");}}},context);
        }}
      ` }
    });
    const config = JSON.parse(readFileSync(resolve(__dirname, "../wrangler.example.jsonc"), "utf8"));
    mf = new Miniflare({ host: "127.0.0.1", port: 0, modules: true, script: bundle.outputFiles[0].text,
      compatibilityDate: config.compatibility_date,
      bindings: { AUTH_COOKIE_SECRET: secret, GATEWAY_BASE_PATH: "/gateway" },
      serviceBindings: { ASSETS: async () => { assetCalls++; return new NativeResponse("private asset"); } },
      outboundService: async () => { outboundCalls++; throw new Error("Unexpected provider request"); }
    });
  }, 30000);
  beforeEach(() => { assetCalls = 0; outboundCalls = 0; });
  afterAll(async () => { await mf?.dispose(); });

  async function token(expiresAt: unknown) {
    return signAuthPayload({ provider: "google", providerId: "fixture", email: "fixture@example.test",
      name: "Fixture", role: "admin", expiresAt } as AuthSession, secret);
  }

  it.each(["non-numeric", "numeric-string", "fractional", "unsafe", "appended", "expired"])(
    "rejects %s session without protected I/O", async kind => {
      const future = Date.now() + 60_000;
      const expiry = kind === "non-numeric" ? "never" : kind === "numeric-string" ? String(future) :
        kind === "fractional" ? future + 0.5 : kind === "unsafe" ? Number.MAX_SAFE_INTEGER + 1 :
          kind === "expired" ? Date.now() - 1 : future;
      const cookie = SESSION_COOKIE + "=" + await token(expiry) + (kind === "appended" ? ".extra" : "");
      for (const [path, method, status] of [
        ["/api/auth/session", "GET", 200], ["/api/admin/health", "GET", 401],
        ["/api/control/tenant-a/evidence-coverage", "GET", 401],
        ["/api/control/tenant-a/proposals", "POST", 401], ["/admin", "GET", 302]
      ] as const) {
        const response = await mf.dispatchFetch("https://gateway.test/gateway" + path, { method,
          headers: { Cookie: cookie, Origin: "https://gateway.test", "Content-Type": "application/json" },
          ...(method === "POST" ? { body: "not-json" } : {}), redirect: "manual" });
        expect(response.status, path).toBe(status);
        if (path === "/api/auth/session") expect(await response.json()).toMatchObject({ authenticated: false, user: null });
        else if (status === 401) expect(await response.json()).toMatchObject({ code: "unauthenticated" });
        else expect(response.headers.get("Location")).toContain("/gateway/login");
      }
      expect(assetCalls).toBe(0);
      expect(outboundCalls).toBe(0);
    });

  it("retains a valid session in the native runtime", async () => {
    const response = await mf.dispatchFetch("https://gateway.test/gateway/api/auth/session", {
      headers: { Cookie: SESSION_COOKIE + "=" + await token(Date.now() + 60_000) } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ authenticated: true, user: { email: "fixture@example.test" } });
    expect(assetCalls).toBe(0);
    expect(outboundCalls).toBe(0);
  });
});
