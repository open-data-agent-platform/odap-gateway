import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const bundler = createRequire(require.resolve("wrangler/package.json"))("esbuild") as typeof import("esbuild");
let mf: Miniflare;

describe("unexpected failures in installed Workers", () => {
  beforeAll(async () => {
    const bundle = await bundler.build({ bundle: true, write: false, format: "esm", platform: "browser",
      stdin: { resolveDir: resolve(__dirname, ".."), contents: `
        import worker from "./worker";
        export default { async fetch(incoming) {
          const params = new URL(incoming.url).searchParams, surface = params.get("surface"), kind = params.get("kind");
          const logs = [], error = new Error("synthetic-native-only: token=private; SELECT private_column");
          let inspections = 0, assets = 0, storage = 0, forwarded = 0;
          if (kind === "getter") Object.defineProperty(error, "message", { get() {
            inspections++; throw new Error("Do not inspect exception metadata");
          }});
          const previousError = console.error, previousFetch = globalThis.fetch;
          console.error = (...args) => { logs.push(args); };
          globalThis.fetch = async () => { forwarded++; throw error; };
          try {
            const path = surface === "assets" ? "/gateway/login" : surface === "storage" ? "/gateway/api/docs/feedback" : "/gateway-other";
            const response = await worker.fetch(new Request("https://gateway.test" + path), {
              GATEWAY_BASE_PATH: "/gateway", GATEWAY_SITE_ORIGIN: "https://gateway.test", GATEWAY_MODE: "production",
              ASSETS: { async fetch() { assets++; throw error; } },
              ODAP_GATEWAY_DB: { prepare() { storage++; throw error; } }
            }, { waitUntil() {} });
            return Response.json({ status: response.status, body: await response.json(),
              cache: response.headers.get("Cache-Control"), cookie: response.headers.get("Set-Cookie"),
              logs, inspections, assets, storage, forwarded });
          } finally { console.error = previousError; globalThis.fetch = previousFetch; }
        }}
      ` } });
    const config = JSON.parse(readFileSync(resolve(__dirname, "../wrangler.example.jsonc"), "utf8"));
    mf = new Miniflare({ host: "127.0.0.1", port: 0, modules: true, script: bundle.outputFiles[0].text,
      compatibilityDate: config.compatibility_date, outboundService: () => { throw new Error("Unexpected network call"); } });
  }, 30000);
  afterAll(async () => { await mf?.dispose(); });

  describe.each(["assets", "storage", "forward"])("%s", surface => {
    it.each(["error", "getter"])("returns a bounded public failure for %s", async kind => {
      const response = await mf.dispatchFetch("http://localhost/?" + new URLSearchParams({ surface, kind }));
      expect(await response.json()).toEqual({ status: 500, cache: "no-store", cookie: null,
        body: { ok: false, code: "internal_error", message: "ODAP Gateway could not complete this request." },
        logs: [[JSON.stringify({ event: "worker_request_failed" })]], inspections: 0,
        assets: surface === "assets" ? 1 : 0, storage: surface === "storage" ? 1 : 0,
        forwarded: surface === "forward" ? 1 : 0 });
    });
  });
});
