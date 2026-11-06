import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { runBigQueryDryRun } from "../lib/bigquery";
import { intentJobIdentity, observeIntentJob } from "../lib/bigquery-job-recovery";

const binding = { tenantId: "tenant", intentId: "intent", actionDigest: "digest", projectId: "demo-project", location: "US" };
const env = { GATEWAY_MODE: "demo" as const, BIGQUERY_PROJECT_ID: binding.projectId, BIGQUERY_LOCATION: binding.location,
  BIGQUERY_CLIENT_EMAIL: "fixture@example.test", BIGQUERY_PRIVATE_KEY: "" };

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  env.BIGQUERY_PRIVATE_KEY = Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).toString("base64");
});
afterEach(() => { vi.restoreAllMocks(); });

function mockWarehouse(body: unknown, status = 200) {
  return vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json({ access_token: "fixture" }))
    .mockResolvedValueOnce(Response.json(body, { status }))
    .mockImplementation(() => { throw new Error("Unexpected retry"); });
}
async function job(state: string) {
  const { jobReference, labels } = await intentJobIdentity(binding);
  return { jobReference, configuration: { jobType: "QUERY", labels }, status: { state } };
}

describe("BigQuery wire contract", () => {
  it("sends a dry-run job, not an executable query job", async () => {
    const http = mockWarehouse({ statistics: { query: { totalBytesProcessed: "0" } } });
    const sql = "SELECT 1";
    const result = await runBigQueryDryRun(sql, { ...env, BIGQUERY_MAX_BYTES_BILLED: "128" });
    expect(result.error).toBeUndefined();
    expect(result.scannedBytes).toBe(0);
    expect(JSON.parse(String(http.mock.calls[1][1]?.body)).configuration).toEqual({
      dryRun: true, query: { query: sql, useLegacySql: false, maximumBytesBilled: "128" }
    });
  });

  it.each([{}, { totalBytesProcessed: "-2" }, { totalBytesProcessed: "9007199254740992" }])(
    "does not approve a preview with unknown or unsafe bytes", async statistics => {
      mockWarehouse({ statistics });
      expect(await runBigQueryDryRun("SELECT 1", env)).toMatchObject({ mode: "live", status: "blocked", error: { code: "bigquery_request_failed" } });
    });

  it("keeps retry identity stable without aliasing tenants or accepting changed actions", async () => {
    const a = await intentJobIdentity(binding);
    expect(await intentJobIdentity({ ...binding })).toEqual(a);
    expect((await intentJobIdentity({ ...binding, tenantId: "other" })).jobReference.jobId).not.toBe(a.jobReference.jobId);
    const changed = await intentJobIdentity({ ...binding, actionDigest: "changed" });
    expect(changed.jobReference.jobId).toBe(a.jobReference.jobId);
    expect(changed.labels).not.toEqual(a.labels);
  });

  it.each([301, 302, 303, 307, 308, 404, 403, 503])("never resubmits after lookup HTTP %i", async status => {
    const http = mockWarehouse({}, status);
    const observation = observeIntentJob(env, binding);
    if (status === 404) await expect(observation).resolves.toEqual({ state: "not-found" });
    else await expect(observation).rejects.toThrow("lookup failed");
    expect(http).toHaveBeenCalledTimes(2);
    const [url, options] = http.mock.calls[1];
    expect(String(url)).toContain("/jobs/odap_");
    expect(new URL(String(url)).searchParams.get("location")).toBe("US");
    expect(options?.method ?? "GET").toBe("GET");
    expect(options?.redirect).toBe("manual");
    expect(options?.body).toBeUndefined();
  });

  it("rejects a job from a different binding and rejects a changed project before lookup", async () => {
    const http = mockWarehouse(await job("DONE"));
    await expect(observeIntentJob(env, { ...binding, projectId: "other" })).rejects.toThrow("target mismatch");
    expect(http).not.toHaveBeenCalled();
    await expect(observeIntentJob(env, { ...binding, actionDigest: "changed" })).rejects.toThrow("Unmatched");
  });

  it.each([
    ["RUNNING", undefined, "10", { state: "pending" }],
    ["DONE", undefined, "0", { state: "succeeded", billedBytes: 0 }],
    ["DONE", "stopped", undefined, { state: "cancelled", billedBytes: null }],
    ["DONE", "invalidQuery", "17", { state: "failed", billedBytes: 17 }],
    ["DONE", undefined, "9007199254740992", { state: "succeeded", billedBytes: null }]
  ] as const)("reads %s / %s / %s", async (state, reason, billed, expected) => {
    const resource = await job(state);
    mockWarehouse({ ...resource, status: { state, ...(reason && { errorResult: { reason } }) },
      statistics: { query: { totalBytesBilled: billed } } });
    expect(await observeIntentJob(env, binding)).toEqual(expected);
  });
});
