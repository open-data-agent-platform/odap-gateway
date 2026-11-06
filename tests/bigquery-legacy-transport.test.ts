import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { runBigQueryDryRun, runBigQueryQuery } from "../lib/bigquery";

const env = { GATEWAY_MODE: "demo" as const, BIGQUERY_PROJECT_ID: "demo-project",
  BIGQUERY_CLIENT_EMAIL: "fixture@example.test", BIGQUERY_PRIVATE_KEY: "" };
const privateMarker = "synthetic-private-upstream-detail";

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  env.BIGQUERY_PRIVATE_KEY = Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).toString("base64");
});
afterEach(() => { vi.restoreAllMocks(); });

describe.each(["dry-run", "query"] as const)("legacy %s transport boundary", operation => {
  const run = () => operation === "dry-run" ? runBigQueryDryRun("SELECT 1", env) : runBigQueryQuery("SELECT 1", env);
  const refusal = (code: string, message: string) => operation === "dry-run"
    ? { mode: "live", status: "blocked", error: { code, message } } : { ok: false, code, message };
  function warehouse(response: Response) {
    return vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ access_token: "synthetic-token" }))
      .mockResolvedValueOnce(response)
      .mockRejectedValue(new Error("Unexpected retry"));
  }

  it.each([301, 302, 303, 307, 308, 400, 401, 403, 429, 500, 503])(
    "refuses HTTP %i without reading an error body or retrying", async status => {
      const response = Response.json({ error: { message: privateMarker, status: privateMarker } },
        { status, statusText: privateMarker, headers: { Location: "https://fixture.invalid/collect" } });
      const parse = vi.spyOn(response, "json");
      const cancel = vi.spyOn(response.body!, "cancel").mockRejectedValue(new Error(privateMarker));
      const http = warehouse(response);
      const redirected = status >= 300 && status < 400;
      expect(await run()).toMatchObject(refusal(redirected ? "bigquery_redirect_refused" : `http_${status}`,
        redirected ? "BigQuery redirects are not permitted." : `BigQuery request failed (HTTP ${status}).`));
      expect(http).toHaveBeenCalledTimes(2);
      expect(http.mock.calls[1][1]?.redirect).toBe("manual");
      expect(parse).not.toHaveBeenCalled();
      expect(cancel).toHaveBeenCalledTimes(1);
    });

  it("rejects an already-redirected success before parsing", async () => {
    const response = Response.json({ statistics: { totalBytesProcessed: "0" }, rows: [] });
    Object.defineProperty(response, "redirected", { value: true });
    const parse = vi.spyOn(response, "json");
    const cancel = vi.spyOn(response.body!, "cancel");
    const http = warehouse(response);
    expect(await run()).toMatchObject(refusal("bigquery_redirect_refused", "BigQuery redirects are not permitted."));
    expect(parse).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(http).toHaveBeenCalledTimes(2);
  });

  it.each(["fetch", "json"])("does not expose %s exception details", async stage => {
    const http = warehouse(new Response(privateMarker));
    if (stage === "fetch") {
      http.mockReset().mockResolvedValueOnce(Response.json({ access_token: "synthetic-token" }))
        .mockRejectedValue(new Error(privateMarker));
    }
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await run();
    expect(result).toMatchObject(refusal(operation === "dry-run" ? "bigquery_request_failed" : "bigquery_query_failed",
      operation === "dry-run" ? "BigQuery request failed." : "BigQuery query failed."));
    expect(JSON.stringify(result)).not.toContain(privateMarker);
    expect(log).not.toHaveBeenCalled();
    expect(http).toHaveBeenCalledTimes(2);
  });

  it("preserves the successful request and result without redirect following", async () => {
    const http = warehouse(Response.json(operation === "dry-run" ? { statistics: { query: { totalBytesProcessed: "17" } } }
      : { jobComplete: true, totalRows: "1", schema: { fields: [{ name: "n", type: "INTEGER" }] }, rows: [{ f: [{ v: "17" }] }] }));
    expect(await run()).toMatchObject(operation === "dry-run" ? { mode: "live", scannedBytes: 17 }
      : { ok: true, totalRows: 1, rows: [{ n: "17" }] });
    expect(http).toHaveBeenCalledTimes(2);
    const [url, init] = http.mock.calls[1];
    expect(String(url)).toBe(`https://bigquery.googleapis.com/bigquery/v2/projects/demo-project/${operation === "dry-run" ? "jobs" : "queries"}`);
    expect(init).toMatchObject({ method: "POST", redirect: "manual", headers: { Authorization: "Bearer synthetic-token" } });
    const body = JSON.parse(String(init?.body));
    if (operation === "dry-run") expect(body.configuration).toMatchObject({ dryRun: true, query: { query: "SELECT 1" } });
    else expect(body).toMatchObject({ query: "SELECT 1", useLegacySql: false });
  });
});

it("keeps an unsuccessful query response failed without exposing its reason or message", async () => {
  const http = vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json({ access_token: "synthetic-token" }))
    .mockResolvedValueOnce(Response.json({ jobComplete: true, errors: [{ reason: privateMarker, message: privateMarker }] }));
  expect(await runBigQueryQuery("SELECT 1", env)).toEqual({ ok: false, code: "bigquery_query_error", message: "BigQuery query failed." });
  expect(http).toHaveBeenCalledTimes(2);
});
