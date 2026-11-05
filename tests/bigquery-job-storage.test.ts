import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { observePreparedIntentJob, prepareIntentJob } from "../lib/bigquery-job-storage";
import type { ControlAccess } from "../lib/control-storage";
import type { D1Database, D1Value } from "../lib/d1";

const run = promisify(execFile);
const target = { BIGQUERY_PROJECT_ID: "demo-project", BIGQUERY_LOCATION: "US" };
let dir: string;
let access: ControlAccess;

async function sqlite(mode: string, sql = "", params: D1Value[] = []) {
  const python = process.env.ODAP_TEST_PYTHON || (process.platform === "win32" ? "python" : "python3");
  const { stdout } = await run(python, ["tests/fixtures/job-binding-sqlite.py", join(dir, "test.db"),
    mode, JSON.stringify([sql, params])]);
  return JSON.parse(stdout);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "odap-binding-"));
  await sqlite("setup");
  const db = { prepare: (sql: string) => ({ bind: (...params: D1Value[]) => ({
    first: () => sqlite("first", sql, params), run: () => sqlite("run", sql, params)
  }) }) } as D1Database;
  access = { db, tenantId: "t", principalId: "owner" };
});
afterEach(async () => { vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); });

describe("durable BigQuery job preparation", { timeout: 20_000 }, () => {
  it("returns the same job and pending evidence to concurrent callers across fresh connections", async () => {
    const jobs = await Promise.all(Array.from({ length: 4 }, () => prepareIntentJob(access, "i", target)));
    for (const job of jobs) expect(job).toEqual(jobs[0]);
    expect(jobs[0].receipt).toMatchObject({ intentId: "i", semanticReleaseId: "r", contractId: "c", outcome: "pending" });
    expect(await sqlite("first", `SELECT (SELECT count(*) FROM bigquery_job_bindings) AS jobs,
      (SELECT count(*) FROM evidence_receipts) AS receipts,
      (SELECT count(*) FROM control_object_events WHERE object_kind='receipt') AS events,
      (SELECT reserved_units FROM control_budgets) AS reserved`)).toEqual({ jobs: 1, receipts: 1, events: 1, reserved: 20 });
    await expect(prepareIntentJob(access, "i", { ...target, BIGQUERY_LOCATION: "EU" })).rejects.toThrow("conflicts");
    await expect(sqlite("run", "UPDATE bigquery_job_bindings SET location='EU'")).rejects.toThrow("immutable");
    await expect(sqlite("run", "DELETE FROM bigquery_job_bindings")).rejects.toThrow("immutable");
    expect(await prepareIntentJob(access, "i", target)).toEqual(jobs[0]);
  });

  it("rolls the binding and evidence back together and can retry after a failed write", async () => {
    await sqlite("run", `CREATE TRIGGER fail_receipt BEFORE INSERT ON control_object_events
      WHEN NEW.object_kind='receipt' BEGIN SELECT RAISE(ABORT,'simulated failure'); END`);
    await expect(prepareIntentJob(access, "i", target)).rejects.toThrow("simulated failure");
    expect(await sqlite("first", `SELECT (SELECT count(*) FROM bigquery_job_bindings) AS jobs,
      (SELECT count(*) FROM evidence_receipts) AS receipts`)).toEqual({ jobs: 0, receipts: 0 });
    await sqlite("run", "DROP TRIGGER fail_receipt");
    expect((await prepareIntentJob(access, "i", target)).receipt.outcome).toBe("pending");
  });

  it("denies missing, cross-tenant and non-owner requests and a withdrawn original principal", async () => {
    await expect(prepareIntentJob(access, "missing", target)).rejects.toThrow("unavailable");
    await expect(prepareIntentJob({ ...access, tenantId: "other" }, "i", target)).rejects.toThrow("unavailable");
    await expect(prepareIntentJob({ ...access, principalId: "user" }, "i", target)).rejects.toThrow("unavailable");
    await sqlite("run", "UPDATE control_memberships SET active=0 WHERE principal_id='user'");
    await expect(prepareIntentJob(access, "i", target)).rejects.toThrow("preparation denied");
    expect(await sqlite("first", "SELECT count(*) AS jobs FROM bigquery_job_bindings")).toEqual({ jobs: 0 });
  });

  it("refuses to prepare an already settled intent", async () => {
    await sqlite("run", `INSERT INTO evidence_receipts(tenant_id,id,contract_id,release_id,payload,created_by)
      VALUES('t','final','c','r',?,'owner')`, [JSON.stringify({ id: "final", tenantId: "t", intentId: "i",
      contractId: "c", semanticReleaseId: "r", outcome: "succeeded" })]);
    await sqlite("run", "INSERT INTO cost_settlements(tenant_id,intent_id,receipt_id,actual_units,actor) VALUES('t','i','final',10,'owner')");
    await expect(prepareIntentJob(access, "i", target)).rejects.toThrow("preparation denied");
  });

  it("recovery stops before network access for a changed target or a removed owner", async () => {
    await prepareIntentJob(access, "i", target);
    const http = vi.spyOn(globalThis, "fetch");
    await expect(observePreparedIntentJob(access, "i", { ...target, BIGQUERY_LOCATION: "EU",
      BIGQUERY_CLIENT_EMAIL: "fixture@example.test", BIGQUERY_PRIVATE_KEY: "must-not-be-used" })).rejects.toThrow("target mismatch");
    await sqlite("run", "UPDATE control_memberships SET active=0 WHERE principal_id='owner'");
    await expect(observePreparedIntentJob(access, "i", target)).rejects.toThrow("unavailable");
    expect(http).not.toHaveBeenCalled();
  });

  it("uses the persisted job reference after restart without submitting or settling a job", async () => {
    const { identity } = await prepareIntentJob(access, "i", target);
    const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
    const privateKey = Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).toString("base64");
    const http = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ access_token: "fixture" }))
      .mockResolvedValueOnce(Response.json({ jobReference: identity.jobReference, configuration: { jobType: "QUERY", labels: identity.labels },
        status: { state: "DONE" }, statistics: { query: { totalBytesBilled: "41" } } }))
      .mockImplementation(() => { throw new Error("Unexpected request"); });
    await expect(observePreparedIntentJob(access, "i", { ...target,
      BIGQUERY_CLIENT_EMAIL: "fixture@example.test", BIGQUERY_PRIVATE_KEY: privateKey }))
      .resolves.toEqual({ state: "succeeded", billedBytes: 41 });
    const [url, options] = http.mock.calls[1];
    expect(new URL(String(url)).pathname).toBe("/bigquery/v2/projects/demo-project/jobs/" + identity.jobReference.jobId);
    expect(options?.method ?? "GET").toBe("GET");
    expect(http).toHaveBeenCalledTimes(2);
    expect(await sqlite("first", "SELECT count(*) AS settlements FROM cost_settlements")).toEqual({ settlements: 0 });
  });
});
