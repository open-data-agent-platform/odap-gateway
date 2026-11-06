import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ReadableStream, type ReadableStreamDefaultController } from "node:stream/web";
import { Miniflare, Response as NativeResponse, type Request as NativeRequest } from "miniflare";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const bundler = createRequire(require.resolve("wrangler/package.json"))("esbuild") as typeof import("esbuild");
const calls: { url: string; method: string; hasAuthorization: boolean; hasBody: boolean }[] = [];
let mf: Miniflare;
let status = 200;
let malformed = false;
let queryError = false;
let bodyMode = "normal";
let activeStream: ReadableStreamDefaultController<Uint8Array> | undefined;

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const privateKey = Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).toString("base64");
  const bundle = await bundler.build({ bundle: true, write: false, format: "esm", platform: "browser",
    stdin: { resolveDir: resolve(__dirname, ".."), contents: `
      import {runBigQueryDryRun,runBigQueryQuery} from "./lib/bigquery";
      export default {async fetch(request,env) {
        const {operation,mode}=await request.json();
        const configured={...env,GATEWAY_MODE:mode};
        return Response.json(await (operation==="dry-run"?runBigQueryDryRun:runBigQueryQuery)("SELECT 1",configured));
      }}
    ` }
  });
  const config = JSON.parse(readFileSync(resolve(__dirname, "../wrangler.example.jsonc"), "utf8"));
  mf = new Miniflare({ host: "127.0.0.1", port: 0, modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: config.compatibility_date,
    bindings: { BIGQUERY_PROJECT_ID: "demo-project", BIGQUERY_CLIENT_EMAIL: "fixture@example.test", BIGQUERY_PRIVATE_KEY: privateKey },
    outboundService: async (request: NativeRequest) => {
      calls.push({ url: request.url, method: request.method, hasAuthorization: request.headers.has("Authorization"),
        hasBody: Boolean(await request.text()) });
      if (request.url === "https://oauth2.googleapis.com/token") return NativeResponse.json({ access_token: "synthetic-token" });
      // All destinations, including forbidden redirect targets, stay inside this fixture.
      if (new URL(request.url).hostname === "bigquery.googleapis.com") {
        if (status !== 200) return NativeResponse.json({ error: { message: "synthetic-private-response", status: "synthetic-private-status" } },
          { status, headers: { Location: "https://fixture.invalid/collect" } });
        if (malformed) return new NativeResponse("synthetic-private-response");
      }
      if (queryError) return NativeResponse.json({ errors: [{ reason: "synthetic-private-reason", message: "synthetic-private-response" }] });
      const payload = JSON.stringify({ statistics: { totalBytesProcessed: "17" }, jobComplete: true, totalRows: "0", rows: [] });
      if (bodyMode === "stall") return new NativeResponse(new ReadableStream<Uint8Array>({
        start(controller) { activeStream = controller; controller.enqueue(new TextEncoder().encode("{")); },
        cancel() { activeStream = undefined; }
      }));
      if (bodyMode === "invalid-utf8") return new NativeResponse(new Uint8Array([34, 0xff, 34]));
      if (bodyMode === "declared-oversized") return new NativeResponse(payload,
        { headers: { "Content-Length": String(256 * 1024 + 1) } });
      if (bodyMode === "oversized" || bodyMode === "ceiling")
        return new NativeResponse(" ".repeat(256 * 1024 + Number(bodyMode === "oversized") - payload.length) + payload);
      return new NativeResponse(payload);
    }
  });
}, 30000);
beforeEach(() => { calls.length = 0; status = 200; malformed = false; queryError = false; bodyMode = "normal"; });
afterEach(() => { activeStream?.close(); activeStream = undefined; });
afterAll(async () => { await mf?.dispose(); });

async function run(operation: string, mode: string | undefined = "demo") {
  return (await mf.dispatchFetch("http://localhost/", { method: "POST", body: JSON.stringify({ operation, mode }) })).json();
}

describe.each(["dry-run", "query"] as const)("legacy %s in Workers", operation => {
  const refusal = (code: string, message: string) => operation === "dry-run"
    ? { mode: "live", status: "blocked", error: { code, message } } : { ok: false, code, message };

  it("retains the successful fixed-endpoint POST", async () => {
    expect(await run(operation)).toMatchObject(operation === "dry-run" ? { scannedBytes: 17, mode: "live" } : { ok: true, rows: [] });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual({ url: `https://bigquery.googleapis.com/bigquery/v2/projects/demo-project/${operation === "dry-run" ? "jobs" : "queries"}`,
      method: "POST", hasAuthorization: true, hasBody: true });
  });

  it.each([301, 302, 303, 307, 308])("does not forward the bearer token or SQL after HTTP %i", async code => {
    status = code;
    const result = await run(operation);
    expect(calls.filter(call => new URL(call.url).hostname === "fixture.invalid" && call.hasAuthorization).length).toBe(0);
    expect(calls.filter(call => new URL(call.url).hostname === "fixture.invalid" && call.hasBody).length).toBe(0);
    expect(calls).toHaveLength(2);
    expect(result).toMatchObject(refusal("bigquery_redirect_refused", "BigQuery redirects are not permitted."));
  });

  it.each(["http-error", "malformed-json"])("does not disclose %s details", async kind => {
    status = kind === "http-error" ? 403 : 200;
    malformed = kind === "malformed-json";
    const result = await run(operation);
    expect(JSON.stringify(result)).not.toContain("synthetic-private");
    expect(result).toMatchObject(kind === "http-error" ? refusal("http_403", "BigQuery request failed (HTTP 403).")
      : refusal(operation === "dry-run" ? "bigquery_request_failed" : "bigquery_query_failed",
        operation === "dry-run" ? "BigQuery request failed." : "BigQuery query failed."));
    expect(calls).toHaveLength(2);
  });

  it.each(["production", "unrecognized"])("still refuses %s before any provider call", async mode => {
    expect(await run(operation, mode)).toMatchObject(operation === "dry-run" ? { status: "blocked" } : { ok: false, code: "legacy_query_disabled" });
    expect(calls).toHaveLength(0);
  });

  it("accepts the exact byte ceiling", async () => {
    bodyMode = "ceiling";
    expect(await run(operation)).toMatchObject(operation === "dry-run" ? { scannedBytes: 17, mode: "live" } : { ok: true, rows: [] });
    expect(calls).toHaveLength(2);
  });

  it.each(["oversized", "declared-oversized", "invalid-utf8"])("refuses %s without retry", async kind => {
    bodyMode = kind;
    expect(await run(operation)).toMatchObject(refusal(operation === "dry-run" ? "bigquery_request_failed" : "bigquery_query_failed",
      operation === "dry-run" ? "BigQuery request failed." : "BigQuery query failed."));
    expect(calls).toHaveLength(2);
  });

  it("ends a real stalled body without retrying", async () => {
    bodyMode = "stall";
    const started = Date.now();
    expect(await run(operation)).toMatchObject(refusal(operation === "dry-run" ? "bigquery_request_failed" : "bigquery_query_failed",
      operation === "dry-run" ? "BigQuery request failed." : "BigQuery query failed."));
    expect(Date.now() - started).toBeGreaterThanOrEqual(14_000);
    expect(Date.now() - started).toBeLessThan(25_000);
    expect(calls).toHaveLength(2);
  }, 30000);
});

it("rejects query errors without returning private provider details", async () => {
  queryError = true;
  expect(await run("query")).toEqual({ ok: false, code: "bigquery_query_error", message: "BigQuery query failed." });
  expect(calls).toHaveLength(2);
});
