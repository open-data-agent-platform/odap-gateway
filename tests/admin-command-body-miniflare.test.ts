import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const bundler = createRequire(require.resolve("wrangler/package.json"))("esbuild") as typeof import("esbuild");
const routes = ["users/target", "feature-flags/target", "schema-fields/target", "run-reviews/target",
  "docs-feedback/target", "schema-import"];
let mf: Miniflare;

describe("administrator body admission in installed Workers", () => {
  beforeAll(async () => {
    const bundle = await bundler.build({ bundle: true, write: false, format: "esm", platform: "browser",
      stdin: { resolveDir: resolve(__dirname, ".."), contents: `
        import worker from "./worker";
        import { signAuthPayload, SESSION_COOKIE } from "./lib/auth";
        export default { async fetch(incoming) {
          const url = new URL(incoming.url), path = url.searchParams.get("path"), mode = url.searchParams.get("mode");
          const secret = "synthetic-native-admin-body-secret";
          const token = await signAuthPayload({ provider: "google", providerId: "fixture", email: "fixture@example.test",
            name: "Fixture", role: "admin", expiresAt: Date.now() + 60000 }, secret);
          let calls = 0, mutations = 0, pulls = 0, cancellations = 0;
          const cancel = () => { cancellations++; return new Promise(() => {}); };
          let body;
          if (mode === "invalid-utf8") body = new Uint8Array([123,34,120,34,58,34,255,34,125]);
          else if (mode === "exact") body = " ".repeat(16368) + '{"role":"owner"}';
          else body = new ReadableStream({ pull(c) { pulls++;
            if (mode === "oversized") c.enqueue(new Uint8Array(16385));
            if (mode.startsWith("request-")) { c.enqueue(new TextEncoder().encode("{}")); c.close(); }
          }, cancel }, { highWaterMark: 0 });
          const headers = new Headers({ Cookie: SESSION_COOKIE + "=" + token,
            Origin: "https://gateway.test", "Content-Type": "application/json" });
          if (mode === "request-missing-origin") headers.delete("Origin");
          if (mode === "request-null-origin") headers.set("Origin", "null");
          if (mode === "request-sibling-origin") headers.set("Origin", "https://other.gateway.test");
          if (mode === "request-form") headers.set("Content-Type", "text/plain");
          const request = new Request("https://gateway.test/gateway/api/admin/" + path, {
            method: path === "schema-import" ? "POST" : "PATCH", body,
            headers
          });
          const db = { prepare(sql) { calls++;
            if (sql !== "SELECT role,email FROM users WHERE id=? AND provider=? AND provider_id=?") {
              mutations++; throw new Error("Unexpected non-authority database access");
            }
            const statement = { bind() { return statement; }, async first() {
              return mode === "revoked" ? null : { role: "admin", email: "fixture@example.test" };
            }}; return statement;
          }};
          const response = await worker.fetch(request, { AUTH_COOKIE_SECRET: secret, ODAP_GATEWAY_DB: db,
            GATEWAY_MODE: "production", GATEWAY_BASE_PATH: "/gateway",
            ASSETS: { fetch() { throw new Error("Unexpected asset lookup"); } }
          }, { waitUntil() {} });
          const result = { status: response.status, body: await response.json(), calls, mutations, pulls,
            cancellations, locked: request.body.locked, cache: response.headers.get("Cache-Control") };
          return Response.json(result);
        }}
      ` } });
    const config = JSON.parse(readFileSync(resolve(__dirname, "../wrangler.example.jsonc"), "utf8"));
    mf = new Miniflare({ host: "127.0.0.1", port: 0, modules: true, script: bundle.outputFiles[0].text,
      compatibilityDate: config.compatibility_date, outboundService: () => { throw new Error("Unexpected network call"); } });
  }, 30000);
  afterAll(async () => { await mf?.dispose(); });
  const run = async (path: string, mode: string) => (await mf.dispatchFetch(
    "http://localhost/?" + new URLSearchParams({ path, mode }))).json();

  describe.each(routes)("request metadata at %s", path => {
    it.each(["request-missing-origin", "request-null-origin", "request-sibling-origin", "request-form"])(
      "refuses %s without consuming the body or reaching business storage", async mode => {
        expect(await run(path, mode)).toMatchObject({ status: mode === "request-form" ? 415 : 403,
          body: { code: mode === "request-form" ? "json_required" : "same_origin_required" },
          calls: 1, mutations: 0, pulls: 0, cancellations: 0, locked: false, cache: "no-store" });
      });
  });

  it.each(routes)("refuses oversized %s before mutation", async path => {
    expect(await run(path, "oversized")).toMatchObject({ status: 413, body: { code: "admin_body_too_large" },
      calls: 1, mutations: 0, cancellations: 1, locked: false, cache: "no-store" });
  });

  it.each(routes)("refuses invalid UTF-8 at %s", async path => {
    expect(await run(path, "invalid-utf8")).toMatchObject({ status: 400,
      body: { code: path.startsWith("feature-flags") ? "invalid_rollout" : "invalid_json" },
      calls: 1, mutations: 0, locked: false, cache: "no-store" });
  });

  it.each(routes)("checks current authority before consuming %s", async path => {
    expect(await run(path, "revoked")).toMatchObject({ status: 403, body: { code: "admin_required" },
      calls: 1, mutations: 0, pulls: 0, cancellations: 0, locked: false, cache: "no-store" });
  });

  it("preserves field validation for an exact-ceiling body", async () => {
    expect(await run("users/target", "exact")).toMatchObject({ status: 400, body: { code: "invalid_user_role" },
      calls: 1, mutations: 0, cancellations: 0, locked: false });
  });

  it("ends a real stalled admin body without a database write", async () => {
    const start = Date.now();
    expect(await run("users/target", "stall")).toMatchObject({ status: 408, body: { code: "admin_body_timeout" },
      calls: 1, mutations: 0, cancellations: 1, locked: false, cache: "no-store" });
    expect(Date.now() - start).toBeGreaterThanOrEqual(14000);
    expect(Date.now() - start).toBeLessThan(25000);
  }, 30000);
});
