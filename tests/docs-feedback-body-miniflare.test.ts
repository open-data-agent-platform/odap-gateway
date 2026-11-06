import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const bundler = createRequire(require.resolve("wrangler/package.json"))("esbuild") as typeof import("esbuild");
let mf: Miniflare;

describe("public feedback body in installed Workers", () => {
  beforeAll(async () => {
    const bundle = await bundler.build({ bundle: true, write: false, format: "esm", platform: "browser",
      stdin: { resolveDir: resolve(__dirname, ".."), contents: `
        import worker from "./worker";
        export default { async fetch(incoming) {
          const mode = new URL(incoming.url).pathname.slice(1), abort = new AbortController();
          let calls = 0, cancellations = 0;
          const cancel = () => { cancellations++; return new Promise(() => {}); };
          let body;
          if (mode === "stall") body = new ReadableStream({ cancel });
          else if (mode === "oversized") body = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(16385)); }, cancel });
          else if (mode === "invalid-utf8") body = new Uint8Array([123,34,99,111,109,112,97,110,121,34,58,34,255,34,125]);
          else if (mode === "stream-error") body = new ReadableStream({ pull(c) { c.error(new Error("synthetic-private-stream")); } });
          else if (mode === "array") body = "[]";
          else body = " ".repeat(16367) + '{"company":"bot"}';
          if (mode === "aborted") abort.abort(new Error("synthetic-private-abort"));
          const request = new Request("https://gateway.test/gateway/api/docs/feedback", {
            method: "POST", body, signal: abort.signal, headers: { "Content-Type": "application/json" }
          });
          const response = await worker.fetch(request, { GATEWAY_MODE: "production", GATEWAY_BASE_PATH: "/gateway",
            DB: { prepare() { calls++; throw new Error("Unexpected feedback storage"); } },
            ASSETS: { fetch() { throw new Error("Unexpected assets"); } }
          }, { waitUntil() {} });
          return Response.json({ status: response.status, body: await response.json(), calls, cancellations,
            locked: request.body.locked, cache: response.headers.get("Cache-Control") });
        }}
      ` } });
    const config = JSON.parse(readFileSync(resolve(__dirname, "../wrangler.example.jsonc"), "utf8"));
    mf = new Miniflare({ host: "127.0.0.1", port: 0, modules: true, script: bundle.outputFiles[0].text,
      compatibilityDate: config.compatibility_date, outboundService: () => { throw new Error("Unexpected network call"); } });
  }, 30000);
  afterAll(async () => { await mf?.dispose(); });
  const run = async (mode: string) => (await mf.dispatchFetch("http://localhost/" + mode)).json();

  it("preserves exact-ceiling honeypot handling without persistence", async () => {
    expect(await run("valid")).toMatchObject({ status: 200, body: { accepted: true, persisted: false, feedback: null },
      calls: 0, cancellations: 0, locked: false, cache: "no-store" });
  });

  it("rejects oversize without waiting for native cancellation or touching storage", async () => {
    expect(await run("oversized")).toMatchObject({ status: 413, body: { ok: false, code: "feedback_too_large" },
      calls: 0, cancellations: 1, locked: false, cache: "no-store" });
  });

  it.each(["invalid-utf8", "aborted", "stream-error", "array"])("refuses %s before storage", async mode => {
    const result = await run(mode);
    expect(result).toMatchObject({ status: 400, body: { ok: false, code: "invalid_json" }, calls: 0, locked: false, cache: "no-store" });
    expect(JSON.stringify(result)).not.toContain("synthetic-private");
  });

  it("ends a real stalled body with no feedback database access", async () => {
    const start = Date.now();
    expect(await run("stall")).toMatchObject({ status: 408, body: { ok: false, code: "feedback_timeout" },
      calls: 0, cancellations: 1, locked: false, cache: "no-store" });
    expect(Date.now() - start).toBeGreaterThanOrEqual(14_000);
    expect(Date.now() - start).toBeLessThan(25_000);
  }, 30000);
});
