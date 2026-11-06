import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ReadableStream, type ReadableStreamDefaultController } from "node:stream/web";
import { Miniflare, Response as NativeResponse, type Request as NativeRequest } from "miniflare";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const bundler = createRequire(require.resolve("wrangler/package.json"))("esbuild") as typeof import("esbuild");
let mf: Miniflare;
let mode = "valid";
let calls = 0;
let activeStream: ReadableStreamDefaultController<Uint8Array> | undefined;

describe("OAuth JSON bounds in installed Workers", () => {
  beforeAll(async () => {
    const bundle = await bundler.build({ bundle: true, write: false, format: "esm", platform: "browser",
      stdin: { resolveDir: resolve(__dirname, ".."), contents: `
        import {fetchOAuthJson} from "./lib/oauth-provider-json";
        export default {async fetch() {
          try {await fetchOAuthJson("https://provider.example.test/profile",{}); return Response.json({accepted:true});}
          catch(error) {return Response.json({accepted:false,error:error.message});}
        }}
      ` }
    });
    const config = JSON.parse(readFileSync(resolve(__dirname, "../wrangler.example.jsonc"), "utf8"));
    mf = new Miniflare({ host: "127.0.0.1", port: 0, modules: true, script: bundle.outputFiles[0].text,
      compatibilityDate: config.compatibility_date, outboundService: async (request: NativeRequest) => {
        calls++;
        if (request.url !== "https://provider.example.test/profile") throw new Error("Unexpected destination");
        if (mode === "stall") return new NativeResponse(new ReadableStream<Uint8Array>({
          start(controller) { activeStream = controller; controller.enqueue(new TextEncoder().encode("{")); },
          cancel() { activeStream = undefined; }
        }));
        if (mode === "invalid-utf8") return new NativeResponse(new Uint8Array([34, 0xff, 34]));
        if (mode === "declared-oversized") return new NativeResponse("{}", { headers: { "Content-Length": String(256 * 1024 + 1) } });
        const size = mode === "oversized" ? 256 * 1024 + 1 : 256 * 1024;
        return new NativeResponse(" ".repeat(size - 2) + "{}");
      }
    });
  }, 30000);
  beforeEach(() => { calls = 0; mode = "valid"; });
  afterEach(() => { activeStream?.close(); activeStream = undefined; });
  afterAll(async () => { await mf?.dispose(); });

  async function run() { return (await mf.dispatchFetch("http://localhost/")).json(); }

  it("accepts a JSON response exactly at the byte ceiling", async () => {
    expect(await run()).toEqual({ accepted: true });
    expect(calls).toBe(1);
  });

  it.each(["oversized", "declared-oversized", "invalid-utf8"])("refuses %s without a follow-up request", async kind => {
    mode = kind;
    expect(await run()).toEqual({ accepted: false, error: "OAuth provider request failed" });
    expect(calls).toBe(1);
  });

  it("ends a real stalled response stream at the request deadline", async () => {
    mode = "stall";
    const start = Date.now();
    expect(await run()).toEqual({ accepted: false, error: "OAuth provider request failed" });
    expect(Date.now() - start).toBeGreaterThanOrEqual(14_000);
    expect(Date.now() - start).toBeLessThan(25_000);
    expect(calls).toBe(1);
  }, 30000);
});
