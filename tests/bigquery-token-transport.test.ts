import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createBigQueryAccessToken, runBigQueryDryRun, runBigQueryQuery } from "../lib/bigquery";
import { observeIntentJob } from "../lib/bigquery-job-recovery";

const endpoint = "https://oauth2.googleapis.com/token";
const failure = "Google OAuth token exchange failed.";
const privateMarker = "synthetic-private-provider-detail";
const env = { GATEWAY_MODE: "demo" as const, BIGQUERY_PROJECT_ID: "demo-project", BIGQUERY_LOCATION: "US",
  BIGQUERY_CLIENT_EMAIL: "fixture@example.test", BIGQUERY_PRIVATE_KEY: "" };
let publicKey: CryptoKey;

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  publicKey = pair.publicKey;
  env.BIGQUERY_PRIVATE_KEY = Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).toString("base64");
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("BigQuery service-account token boundary", () => {
  it("posts a signed assertion only to the fixed audience with manual redirects", async () => {
    const http = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ access_token: "synthetic-token" }));
    expect(await createBigQueryAccessToken(env)).toBe("synthetic-token");
    expect(http).toHaveBeenCalledTimes(1);
    const [url, init] = http.mock.calls[0];
    expect(url).toBe(endpoint);
    expect(init).toMatchObject({ method: "POST", redirect: "manual" });
    const form = new URLSearchParams(String(init?.body));
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const [header, payload, signature] = form.get("assertion")!.split(".");
    expect(JSON.parse(Buffer.from(payload, "base64url").toString())).toMatchObject({ iss: env.BIGQUERY_CLIENT_EMAIL, aud: endpoint });
    expect(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey,
      Buffer.from(signature, "base64url"), new TextEncoder().encode(`${header}.${payload}`))).toBe(true);
  });

  it.each([301, 302, 303, 307, 308, 400, 401, 403, 429, 500, 503])(
    "discards HTTP %i before reading the body and never retries", async status => {
      const response = Response.json({ access_token: "must-not-be-used", error_description: privateMarker },
        { status, headers: { Location: "https://fixture.invalid/collect" } });
      const parse = vi.spyOn(response, "json");
      const cancel = vi.spyOn(response.body!, "cancel").mockRejectedValue(new Error(privateMarker));
      const http = vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
      await expect(createBigQueryAccessToken(env)).rejects.toThrow(failure);
      expect(http).toHaveBeenCalledTimes(1);
      expect(http.mock.calls[0][1]?.redirect).toBe("manual");
      expect(parse).not.toHaveBeenCalled();
      expect(cancel).toHaveBeenCalledTimes(1);
    });

  it("refuses an already-redirected success without consuming its token", async () => {
    const response = Response.json({ access_token: "must-not-be-used" });
    Object.defineProperty(response, "redirected", { value: true });
    const parse = vi.spyOn(response, "json");
    const cancel = vi.spyOn(response.body!, "cancel");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
    await expect(createBigQueryAccessToken(env)).rejects.toThrow(failure);
    expect(parse).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it.each([null, {}, [], { access_token: null }, { access_token: false }, { access_token: 42 },
    { access_token: {} }, { access_token: [] }, { access_token: "" }, { access_token: " " },
    { access_token: "token\r\nInjected: yes" }, { access_token: "token\u007f" }])(
    "refuses malformed successful token payload %j", async body => {
      const http = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(body));
      await expect(createBigQueryAccessToken(env)).rejects.toThrow(failure);
      expect(http).toHaveBeenCalledTimes(1);
    });

  it.each(["fetch", "json", "sign"])("sanitizes the %s failure without logging its details", async stage => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const http = vi.spyOn(globalThis, "fetch");
    if (stage === "fetch") http.mockRejectedValue(new Error(privateMarker));
    if (stage === "json") http.mockResolvedValue(new Response(privateMarker));
    if (stage === "sign") vi.spyOn(crypto.subtle, "sign").mockRejectedValue(new Error(privateMarker));
    await expect(createBigQueryAccessToken(env)).rejects.toEqual(new Error(failure));
    expect(log).not.toHaveBeenCalled();
    expect(http).toHaveBeenCalledTimes(stage === "sign" ? 0 : 1);
  });

  it.each(["dry-run", "query", "observe"])("stops %s after token refusal without a BigQuery call", async operation => {
    const http = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ error_description: privateMarker }, { status: 400 }));
    if (operation === "dry-run") {
      expect(await runBigQueryDryRun("SELECT 1", env)).toMatchObject({ status: "blocked", error: { message: "BigQuery request failed." } });
    } else if (operation === "query") {
      expect(await runBigQueryQuery("SELECT 1", env)).toMatchObject({ ok: false, message: "BigQuery query failed." });
    } else {
      await expect(observeIntentJob(env, { tenantId: "fixture", intentId: "intent", actionDigest: "digest",
        projectId: env.BIGQUERY_PROJECT_ID, location: env.BIGQUERY_LOCATION })).rejects.toThrow(failure);
    }
    expect(http).toHaveBeenCalledTimes(1);
    expect(http.mock.calls[0][0]).toBe(endpoint);
  });

  it("accepts a token response exactly at the byte ceiling", async () => {
    vi.useFakeTimers();
    const json = JSON.stringify({ access_token: "synthetic-token" });
    const http = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(json.padEnd(256 * 1024, " ")));
    expect(await createBigQueryAccessToken(env)).toBe("synthetic-token");
    expect(http).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([undefined, "1", "garbage"])("bounds token bytes despite Content-Length %s", async length => {
    const json = JSON.stringify({ access_token: "must-not-be-used" }).padEnd(256 * 1024 + 1, " ");
    const http = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(json,
      { headers: length ? { "Content-Length": length } : {} }));
    await expect(createBigQueryAccessToken(env)).rejects.toEqual(new Error(failure));
    expect(http).toHaveBeenCalledOnce();
  });

  it("discards a declared oversized token response before reading", async () => {
    const response = Response.json({ access_token: "must-not-be-used" },
      { headers: { "Content-Length": String(256 * 1024 + 1) } });
    const read = vi.spyOn(response.body!, "getReader");
    const cancel = vi.spyOn(response.body!, "cancel");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
    await expect(createBigQueryAccessToken(env)).rejects.toEqual(new Error(failure));
    expect(read).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("refuses invalid UTF-8 even outside the access token field", async () => {
    const bytes = Buffer.concat([Buffer.from('{"access_token":"synthetic-token","unused":"'),
      Buffer.from([0xff]), Buffer.from('"}')]);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(bytes));
    await expect(createBigQueryAccessToken(env)).rejects.toEqual(new Error(failure));
  });

  for (const operation of ["token", "dry-run", "query", "observe"] as const) {
    it(`bounds stalled token headers for ${operation}, ignores late success and never retries`, async () => {
      vi.useFakeTimers();
      let arrive!: (response: Response) => void, started!: () => void;
      const called = new Promise<void>(resolve => { started = resolve; });
      const http = vi.spyOn(globalThis, "fetch").mockImplementation(async url => {
        if (url !== endpoint) return new Response(null, { status: 500 });
        started();
        return new Promise<Response>(resolve => { arrive = resolve; });
      });
      let settled: unknown;
      const task = runOperation(operation).then(result => { settled = result; });
      await called;
      await vi.advanceTimersByTimeAsync(15_000);
      const atDeadline = settled;
      const response = Response.json({ access_token: "must-not-be-used" });
      const cancel = vi.spyOn(response.body!, "cancel");
      const read = vi.spyOn(response.body!, "getReader");
      // Settle the pre-fix fixture too, so a failed baseline leaves no pending work.
      arrive(response);
      await task;
      await vi.advanceTimersByTimeAsync(0);
      expect(atDeadline).toMatchObject(expectedFailure(operation));
      expect(http).toHaveBeenCalledOnce();
      expect(http.mock.calls[0][1]?.signal?.aborted).toBe(true);
      expect(read).not.toHaveBeenCalled();
      expect(cancel).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    });

    it(`bounds a stalled token body for ${operation} even if cancellation hangs`, async () => {
      vi.useFakeTimers();
      let stream!: ReadableStreamDefaultController<Uint8Array>, started!: () => void;
      const called = new Promise<void>(resolve => { started = resolve; });
      const cancel = vi.fn(() => new Promise<void>(() => {}));
      const body = new ReadableStream<Uint8Array>({ start(controller) { stream = controller; }, cancel });
      const http = vi.spyOn(globalThis, "fetch").mockImplementation(async () => { started(); return new Response(body); });
      let settled: unknown;
      const task = runOperation(operation).then(result => { settled = result; });
      await called;
      await vi.advanceTimersByTimeAsync(15_000);
      const atDeadline = settled;
      stream.error(new Error("synthetic-stalled-body-cleanup"));
      await task;
      expect(atDeadline).toMatchObject(expectedFailure(operation));
      expect(http).toHaveBeenCalledOnce();
      expect(http.mock.calls[0][0]).toBe(endpoint);
      expect(http.mock.calls[0][1]?.signal?.aborted).toBe(true);
      expect(cancel).toHaveBeenCalledOnce();
      expect(body.locked).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    });
  }
});

type Operation = "token" | "dry-run" | "query" | "observe";

function expectedFailure(operation: Operation) {
  if (operation === "dry-run") return { status: "blocked", error: { message: "BigQuery request failed." } };
  if (operation === "query") return { ok: false, message: "BigQuery query failed." };
  return { error: failure };
}

async function runOperation(operation: Operation) {
  try {
    if (operation === "dry-run") return await runBigQueryDryRun("SELECT 1", env);
    if (operation === "query") return await runBigQueryQuery("SELECT 1", env);
    if (operation === "observe") return await observeIntentJob(env, { tenantId: "fixture", intentId: "intent", actionDigest: "digest",
      projectId: env.BIGQUERY_PROJECT_ID, location: env.BIGQUERY_LOCATION });
    return { token: await createBigQueryAccessToken(env) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "unknown" };
  }
}
