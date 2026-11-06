import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const bundler = createRequire(require.resolve("wrangler/package.json"))("esbuild") as typeof import("esbuild");
let mf: Miniflare;

describe("dry-run body admission in installed Workers", () => {
  beforeAll(async () => {
    const bundle = await bundler.build({ bundle: true, write: false, format: "esm", platform: "browser",
      stdin: { resolveDir: resolve(__dirname, ".."), contents: `
        import worker from "./worker";
        import { signAuthPayload, SESSION_COOKIE } from "./lib/auth";
        export default { async fetch(incoming) {
          const mode = new URL(incoming.url).pathname.slice(1), secret = "synthetic-native-query-body";
          const token = await signAuthPayload({ provider: "google", providerId: "fixture", email: "fixture@example.test",
            name: "Fixture", role: "member", expiresAt: Date.now() + 60000 }, secret);
          let calls = 0, pulls = 0, cancellations = 0;
          const cancel = () => { cancellations++; return new Promise(() => {}); };
          let body;
          if (mode === "invalid-utf8") body = new Uint8Array([123,34,115,113,108,34,58,34,255,34,125]);
          else if (mode === "array") body = "[]";
          else if (mode === "exact") body = " ".repeat(131070) + "{}";
          else if (mode === "sql-limit") body = JSON.stringify({ sql: "x".repeat(20001) });
          else body = new ReadableStream({ pull(c) { pulls++;
            if (mode === "oversized") c.enqueue(new Uint8Array(131073));
          }, cancel }, { highWaterMark: 0 });
          const request = new Request("https://gateway.test/gateway/api/query/dry-run", {
            method: "POST", body, headers: { Cookie: mode === "anonymous" ? "" : SESSION_COOKIE + "=" + token }
          });
          const db = { prepare() { calls++; throw new Error("Unexpected catalog/history read"); },
            async batch() { calls++; throw new Error("Unexpected history write"); } };
          const response = await worker.fetch(request, { AUTH_COOKIE_SECRET: secret, ODAP_GATEWAY_DB: db,
            GATEWAY_MODE: mode === "production" ? "production" : "demo", GATEWAY_BASE_PATH: "/gateway",
            BIGQUERY_PROJECT_ID: "fixture-project", BIGQUERY_CLIENT_EMAIL: "fixture@example.test",
            BIGQUERY_PRIVATE_KEY: "synthetic-unused-key",
            ASSETS: { fetch() { throw new Error("Unexpected asset lookup"); } }
          }, { waitUntil() {} });
          return Response.json({ status: response.status, body: await response.json(), calls, pulls,
            cancellations, locked: request.body.locked, cache: response.headers.get("Cache-Control") });
        }}
      ` } });
    const config = JSON.parse(readFileSync(resolve(__dirname, "../wrangler.example.jsonc"), "utf8"));
    mf = new Miniflare({ host: "127.0.0.1", port: 0, modules: true, script: bundle.outputFiles[0].text,
      compatibilityDate: config.compatibility_date, outboundService: () => { throw new Error("Unexpected provider call"); } });
  }, 30000);
  afterAll(async () => { await mf?.dispose(); });
  const run = async (mode: string) => (await mf.dispatchFetch("http://localhost/" + mode)).json();

  it.each([
    ["oversized", 413, "dry_run_body_too_large"], ["invalid-utf8", 400, "invalid_json"],
    ["array", 400, "invalid_json"], ["exact", 400, "sql_required"], ["sql-limit", 400, "sql_too_large"]
  ])("preserves %s admission without catalog/history or provider calls", async (mode, status, code) => {
    expect(await run(String(mode))).toMatchObject({ status, body: { ok: false, code }, calls: 0,
      cancellations: mode === "oversized" ? 1 : 0, locked: false, cache: "no-store" });
  });

  it.each([["anonymous", 401, "unauthenticated"], ["production", 403, "production_preview_scope_unbound"]])(
    "retains %s refusal before reading the stream", async (mode, status, code) => {
      expect(await run(String(mode))).toMatchObject({ status, body: { ok: false, code }, calls: 0,
        pulls: 0, cancellations: 0, locked: false, cache: "no-store" });
    });

  it("ends a real stalled preview body without downstream work", async () => {
    const start = Date.now();
    expect(await run("stall")).toMatchObject({ status: 408, body: { code: "dry_run_body_timeout" },
      calls: 0, cancellations: 1, locked: false, cache: "no-store" });
    expect(Date.now() - start).toBeGreaterThanOrEqual(14000);
    expect(Date.now() - start).toBeLessThan(25000);
  }, 30000);
});
