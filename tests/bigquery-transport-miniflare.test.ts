import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Miniflare, Response as NativeResponse, type Request as NativeRequest } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { intentJobIdentity } from "../lib/bigquery-job-identity";

const require = createRequire(import.meta.url);
const bundler = createRequire(require.resolve("wrangler/package.json"))("esbuild") as typeof import("esbuild");
const binding = { tenantId: "fixture", intentId: "intent", actionDigest: "digest", projectId: "demo-project", location: "US" };
let mf: Miniflare;
let identity: Awaited<ReturnType<typeof intentJobIdentity>>;
let status = 200;
const calls: { url: string; method: string; authorization: string | null; body: string }[] = [];

describe("BigQuery transport in the installed Workers runtime", () => {
  beforeAll(async () => {
    identity = await intentJobIdentity(binding);
    const bundle = await bundler.build({
      bundle: true, write: false, format: "esm", platform: "browser",
      stdin: { resolveDir: resolve(__dirname, ".."), contents: `
        import {dispatchBigQueryMetricRead} from "./lib/bigquery-governed-transport";
        import {observeIntentJob} from "./lib/bigquery-job-recovery";
        export default {async fetch(request) {
          const input = await request.json();
          try {
            if (input.operation === "legacy") return Response.json({redirect:new Request("https://fixture.invalid", {redirect:"error"}).redirect});
            if (input.operation === "observe") return Response.json(await observeIntentJob({
              BIGQUERY_PROJECT_ID:input.binding.projectId, BIGQUERY_LOCATION:input.binding.location
            }, input.binding));
            const result = await dispatchBigQueryMetricRead(input, "intent", {}, {}, {
              projectId:"demo-project", location:"US", maxBytesBilled:1024,
              loadDefinition:async () => "unused", getAccessToken:async () => "synthetic-token",
              sendOnce:request => fetch(request)
            });
            return Response.json(result);
          } catch (error) {return Response.json({error:error.message}, {status:500});}
        }}
      ` },
      plugins: [{ name: "isolate-native-transport", setup(build) {
        // Isolate request construction/response handling, not authorization or OAuth.
        // The real claim and credential paths have separate integration suites.
        build.onResolve({ filter: /^\.\/(dispatch-authority|bigquery)$/ }, args => ({ path: args.path, namespace: "fixture" }));
        build.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: args.path === "./bigquery" ?
          'export const hasBigQueryCredentials=()=>true; export const createBigQueryAccessToken=async()=>"synthetic-token";' :
          'export async function dispatchPreparedMetricRead(input,id,subject,action,adapter){const send=await adapter.prepareRead(input.submission);return send();}' }));
      } }]
    });
    const config = JSON.parse(readFileSync(resolve(__dirname, "../wrangler.example.jsonc"), "utf8"));
    mf = new Miniflare({ host: "127.0.0.1", port: 0, modules: true, script: bundle.outputFiles[0].text,
      compatibilityDate: config.compatibility_date, outboundService: async (request: NativeRequest) => {
        calls.push({ url: request.url, method: request.method, authorization: request.headers.get("Authorization"), body: await request.text() });
        if (new URL(request.url).hostname !== "bigquery.googleapis.com") throw new Error("Unexpected destination");
        if (status !== 200) return new NativeResponse("not-json", { status, headers: { Location: "https://fixture.invalid/collect" } });
        return NativeResponse.json({ jobReference: identity.jobReference, configuration: {
          jobType: "QUERY", labels: identity.labels, query: { maximumBytesBilled: "1024" }
        }, status: { state: "RUNNING" } });
      }
    });
  }, 30000);
  beforeEach(() => { calls.length = 0; status = 200; });
  afterAll(async () => { await mf?.dispose(); });

  async function run(operation: "submit" | "observe" | "legacy") {
    const response = await mf.dispatchFetch("http://localhost/", { method: "POST", body: JSON.stringify({
      operation, binding, submission: { identity, queryConfig: {
        query: "SELECT @p0", useLegacySql: false, maximumBytesBilled: "1024"
      } }
    }) });
    return { status: response.status, body: await response.json() };
  }

  it("preserves the unsupported error-redirect counterexample before any sender call", async () => {
    const result = await run("legacy");
    expect(result.status).toBe(500);
    expect(result.body).toMatchObject({ error: expect.stringContaining("Invalid redirect value") });
    expect(calls).toHaveLength(0);
  });

  it("constructs and sends the actual jobs.insert request in Workers", async () => {
    expect(await run("submit")).toEqual({ status: 200, body: { state: "accepted", jobReference: identity.jobReference } });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "POST", authorization: "Bearer synthetic-token" });
    expect(new URL(calls[0].url).pathname).toBe("/bigquery/v2/projects/demo-project/jobs");
    expect(JSON.parse(calls[0].body)).toMatchObject({ jobReference: identity.jobReference,
      configuration: { labels: identity.labels, query: { maximumBytesBilled: "1024" } } });
  });

  it.each([301, 302, 303, 307, 308])("never follows jobs.insert redirect %s or calls the sender again", async code => {
    status = code;
    expect(await run("submit")).toEqual({ status: 200, body: { state: "observation-required", jobReference: identity.jobReference } });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
  });

  it("observes the pinned job using GET without constructing an executable job", async () => {
    expect(await run("observe")).toEqual({ status: 200, body: { state: "pending" } });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "GET", body: "", authorization: "Bearer synthetic-token" });
    expect(new URL(calls[0].url).pathname).toBe("/bigquery/v2/projects/demo-project/jobs/" + identity.jobReference.jobId);
    expect(new URL(calls[0].url).searchParams.get("location")).toBe("US");
  });

  it.each([301, 302, 303, 307, 308])("refuses observation redirect %s without follow-up or submission", async code => {
    status = code;
    expect(await run("observe")).toEqual({ status: 500, body: { error: `BigQuery job lookup failed (HTTP ${code})` } });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("GET");
  });

  it("preserves not-found without a resubmission", async () => {
    status = 404;
    expect(await run("observe")).toEqual({ status: 200, body: { state: "not-found" } });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("GET");
  });
});
