import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ReadableStream, type ReadableStreamDefaultController } from "node:stream/web";
import { Miniflare, Response as NativeResponse, type Request as NativeRequest } from "miniflare";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const bundler = createRequire(require.resolve("wrangler/package.json"))("esbuild") as typeof import("esbuild");
const endpoint = "https://oauth2.googleapis.com/token";
const calls: { url: string; method: string; hasAssertion: boolean }[] = [];
let mf: Miniflare;
let status = 200;
let malformed = false;
let boundMode = "normal";
let activeStream: ReadableStreamDefaultController<Uint8Array> | undefined;

describe("service-account token exchange in the installed Workers runtime", () => {
  beforeAll(async () => {
    const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
    const privateKey = Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).toString("base64");
    const bundle = await bundler.build({ bundle: true, write: false, format: "esm", platform: "browser",
      stdin: { resolveDir: resolve(__dirname, ".."), contents: `
        import {createBigQueryAccessToken} from "./lib/bigquery";
        export default {async fetch(request,env) {
          try {return Response.json({accepted:await createBigQueryAccessToken(env)==="synthetic-token"});}
          catch(error) {return Response.json({error:error.message},{status:502});}
        }}
      ` }
    });
    const config = JSON.parse(readFileSync(resolve(__dirname, "../wrangler.example.jsonc"), "utf8"));
    mf = new Miniflare({ host: "127.0.0.1", port: 0, modules: true, script: bundle.outputFiles[0].text,
      compatibilityDate: config.compatibility_date,
      bindings: { BIGQUERY_CLIENT_EMAIL: "fixture@example.test", BIGQUERY_PRIVATE_KEY: privateKey },
      outboundService: async (request: NativeRequest) => {
        const form = new URLSearchParams(await request.text());
        calls.push({ url: request.url, method: request.method, hasAssertion: Boolean(form.get("assertion")) });
        // Every destination is intercepted locally, including a forbidden follow-up.
        if (request.url !== endpoint) return NativeResponse.json({ access_token: "synthetic-token" });
        if (malformed) return new NativeResponse("synthetic-private-response");
        if (status !== 200) return NativeResponse.json({ error_description: "synthetic-private-response" },
          { status, headers: { Location: "https://fixture.invalid/collect" } });
        if (boundMode === "stall") return new NativeResponse(new ReadableStream<Uint8Array>({
          start(controller) { activeStream = controller; controller.enqueue(new TextEncoder().encode("{")); },
          cancel() { activeStream = undefined; }
        }));
        if (boundMode === "invalid-utf8") return new NativeResponse(Buffer.concat([
          Buffer.from('{"access_token":"synthetic-token","unused":"'), Buffer.from([0xff]), Buffer.from('"}')
        ]));
        if (boundMode === "declared-oversized") return NativeResponse.json({ access_token: "synthetic-token" },
          { headers: { "Content-Length": String(256 * 1024 + 1) } });
        if (boundMode === "ceiling" || boundMode === "oversized") return new NativeResponse(
          JSON.stringify({ access_token: "synthetic-token" }).padEnd(256 * 1024 + (boundMode === "oversized" ? 1 : 0), " "));
        return NativeResponse.json({ access_token: "synthetic-token" });
      }
    });
  }, 30000);
  beforeEach(() => { calls.length = 0; status = 200; malformed = false; boundMode = "normal"; });
  afterEach(() => { activeStream?.close(); activeStream = undefined; });
  afterAll(async () => { await mf?.dispose(); });

  async function run() {
    const response = await mf.dispatchFetch("http://localhost/");
    return { status: response.status, body: await response.json() };
  }

  it("signs and exchanges a synthetic assertion in Workers", async () => {
    expect(await run()).toEqual({ status: 200, body: { accepted: true } });
    expect(calls).toEqual([{ url: endpoint, method: "POST", hasAssertion: true }]);
  });

  it.each([301, 302, 303, 307, 308])("does not forward the assertion after HTTP %i", async code => {
    status = code;
    const result = await run();
    expect(calls.filter(call => call.url !== endpoint && call.hasAssertion).length).toBe(0);
    expect(calls).toEqual([{ url: endpoint, method: "POST", hasAssertion: true }]);
    expect(result).toEqual({ status: 502, body: { error: "Google OAuth token exchange failed." } });
  });

  it.each(["http-error", "malformed-json"])("does not expose %s details", async kind => {
    status = kind === "http-error" ? 400 : 200;
    malformed = kind === "malformed-json";
    expect(await run()).toEqual({ status: 502, body: { error: "Google OAuth token exchange failed." } });
    expect(calls).toEqual([{ url: endpoint, method: "POST", hasAssertion: true }]);
  });

  it("accepts a token response at the exact byte ceiling in Workers", async () => {
    boundMode = "ceiling";
    expect(await run()).toEqual({ status: 200, body: { accepted: true } });
    expect(calls).toEqual([{ url: endpoint, method: "POST", hasAssertion: true }]);
  });

  it.each(["oversized", "declared-oversized", "invalid-utf8"])("bounds %s token data in Workers", async kind => {
    boundMode = kind;
    expect(await run()).toEqual({ status: 502, body: { error: "Google OAuth token exchange failed." } });
    expect(calls).toEqual([{ url: endpoint, method: "POST", hasAssertion: true }]);
  });

  it("ends a real stalled token stream without retrying the assertion", async () => {
    boundMode = "stall";
    const start = Date.now();
    expect(await run()).toEqual({ status: 502, body: { error: "Google OAuth token exchange failed." } });
    expect(Date.now() - start).toBeGreaterThanOrEqual(14_000);
    expect(Date.now() - start).toBeLessThan(25_000);
    expect(calls).toEqual([{ url: endpoint, method: "POST", hasAssertion: true }]);
  }, 30000);
});
