import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readJobCancellation, requestJobCancellation } from "../lib/bigquery-cancellation";
import { sendRequestedJobCancellation } from "../lib/bigquery-cancellation-transport";
import { prepareIntentJob } from "../lib/bigquery-job-storage";
import type { ControlAccess } from "../lib/control-storage";
import { jobDatabase, jobSqlite } from "./fixtures/job-sqlite";

let dir: string, file: string, access: ControlAccess;
let identity: Awaited<ReturnType<typeof prepareIntentJob>>["identity"];
const run = (sql: string) => jobSqlite(file, "run", sql);
const token = () => vi.fn(async () => "synthetic-cancellation-token");
const held = () => jobSqlite(file, "readonly-first", `SELECT reserved_units,spent_units,
  (SELECT count(*) FROM cost_settlements) AS settlements,(SELECT count(*) FROM evidence_receipts) AS receipts,
  (SELECT count(*) FROM bigquery_terminal_observations) AS observations,
  (SELECT count(*) FROM bigquery_cancellation_requests) AS requests FROM control_budgets`);
const claim = () => run("INSERT INTO dispatch_claims(tenant_id,intent_id,claimed_by,maximum_bytes_billed) VALUES('t','i','owner',128)");
const terminal = () => run("INSERT INTO bigquery_terminal_observations(tenant_id,intent_id,outcome,has_bytes,observed_by) VALUES('t','i','cancelled',0,'owner')");

describe("explicit cancellation transport with stored owner authority", { timeout: 20000 }, () => {
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "odap-cancel-transport-")); file = join(dir, "test.db");
    await jobSqlite(file, "setup");
    access = { db: jobDatabase(() => file), tenantId: "t", principalId: "owner" };
    identity = (await prepareIntentJob(access, "i", { BIGQUERY_PROJECT_ID: "demo-project", BIGQUERY_LOCATION: "us-central1" })).identity;
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network"));
  });
  afterEach(async () => { vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); });

  it.each([200, 202, 302, 400, 401, 403, 404, 409, 429, 500])("sends only the stored cancellation and retains uncertainty after HTTP %s", async status => {
    await claim(); await requestJobCancellation(access, "i");
    const before = await held(), getAccessToken = token();
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }), { status, headers: { Location: "https://untrusted.invalid/" } });
    const sendOnce = vi.fn(async (request: Request) => {
      expect(request.method).toBe("POST"); expect(request.redirect).toBe("manual"); expect(request.body).toBeNull();
      expect(request.headers.get("Authorization")).toBe("Bearer synthetic-cancellation-token");
      const url = new URL(request.url);
      expect(url.origin).toBe("https://bigquery.googleapis.com");
      expect(url.pathname).toBe(`/bigquery/v2/projects/demo-project/jobs/${identity.jobReference.jobId}/cancel`);
      expect([...url.searchParams]).toEqual([["location", "us-central1"]]);
      return response;
    });
    expect(await sendRequestedJobCancellation(access, "i", { getAccessToken, sendOnce }))
      .toEqual({ state: "observation-required", jobReference: identity.jobReference });
    expect(sendOnce).toHaveBeenCalledTimes(1); expect(getAccessToken).toHaveBeenCalledTimes(1); expect(cancel).toHaveBeenCalledTimes(1);
    expect(await held()).toEqual(before);
    expect(await readJobCancellation(access, "i")).toMatchObject({ state: "requested" });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it("does not create a cancellation request or load credentials on a read-only no-request result", async () => {
    await claim(); const before = await held(), getAccessToken = token(), sendOnce = vi.fn();
    expect(await sendRequestedJobCancellation(access, "i", { getAccessToken, sendOnce }))
      .toMatchObject({ state: "not-sent", reason: "not-requested" });
    expect(getAccessToken).not.toHaveBeenCalled(); expect(sendOnce).not.toHaveBeenCalled(); expect(await held()).toEqual(before);
  });
  it("refuses an unclaimed intent without credential or provider access", async () => {
    const getAccessToken = token(), sendOnce = vi.fn();
    await expect(sendRequestedJobCancellation(access, "i", { getAccessToken, sendOnce })).rejects.toThrow("cancellation transport unavailable");
    expect(getAccessToken).not.toHaveBeenCalled(); expect(sendOnce).not.toHaveBeenCalled();
  });
  it.each(["user", "absent"])("refuses non-owner %s before credential access", async principalId => {
    await claim(); await requestJobCancellation(access, "i");
    const getAccessToken = token(), sendOnce = vi.fn();
    await expect(sendRequestedJobCancellation({ ...access, principalId }, "i", { getAccessToken, sendOnce })).rejects.toThrow("unavailable");
    expect(getAccessToken).not.toHaveBeenCalled(); expect(sendOnce).not.toHaveBeenCalled();
  });
  it("refuses a foreign tenant before credential access", async () => {
    await claim(); await requestJobCancellation(access, "i");
    const getAccessToken = token(), sendOnce = vi.fn();
    await expect(sendRequestedJobCancellation({ ...access, tenantId: "other" }, "i", { getAccessToken, sendOnce })).rejects.toThrow("unavailable");
    expect(getAccessToken).not.toHaveBeenCalled(); expect(sendOnce).not.toHaveBeenCalled();
  });
  it.each([false, true])("does not send after a terminal observation (during authentication=%s)", async during => {
    await claim(); await requestJobCancellation(access, "i"); if (!during) await terminal();
    const getAccessToken = vi.fn(async () => { if (during) await terminal(); return "synthetic-token"; }), sendOnce = vi.fn();
    expect(await sendRequestedJobCancellation(access, "i", { getAccessToken, sendOnce })).toMatchObject({ state: "not-sent", reason: "terminal" });
    expect(getAccessToken).toHaveBeenCalledTimes(during ? 1 : 0); expect(sendOnce).not.toHaveBeenCalled();
    expect(await held()).toMatchObject({ reserved_units: 20, spent_units: 0, settlements: 0, receipts: 1, observations: 1 });
  });
  it.each(["UPDATE control_memberships SET active=0 WHERE principal_id='owner'",
    "UPDATE control_memberships SET role='reader' WHERE principal_id='owner'"])("rechecks owner authority after token preparation: %s", async sql => {
    await claim(); await requestJobCancellation(access, "i"); const before = await held(), sendOnce = vi.fn();
    await expect(sendRequestedJobCancellation(access, "i", { sendOnce, getAccessToken: async () => { await run(sql); return "synthetic-token"; } }))
      .rejects.toThrow("cancellation transport unavailable");
    expect(sendOnce).not.toHaveBeenCalled(); expect(await held()).toEqual(before);
  });
  it.each(["", "has space", "line\nbreak", "\u00e9"])("refuses an invalid token without revealing it: %j", async value => {
    await claim(); await requestJobCancellation(access, "i"); const sendOnce = vi.fn();
    await expect(sendRequestedJobCancellation(access, "i", { sendOnce, getAccessToken: async () => value }))
      .rejects.toThrow(/^BigQuery cancellation transport unavailable$/);
    expect(sendOnce).not.toHaveBeenCalled();
  });
  it("does not expose token-loader diagnostics or send on an authentication failure", async () => {
    await claim(); await requestJobCancellation(access, "i"); const sendOnce = vi.fn();
    await expect(sendRequestedJobCancellation(access, "i", { sendOnce, getAccessToken: async () => { throw new Error("private provider diagnostic"); } }))
      .rejects.toThrow(/^BigQuery cancellation transport unavailable$/);
    expect(sendOnce).not.toHaveBeenCalled();
  });
  it("does not retry a thrown sender, infer cancellation or release its hold", async () => {
    await claim(); await requestJobCancellation(access, "i"); const before = await held();
    const sendOnce = vi.fn(async () => { throw new Error("private transport diagnostic"); });
    expect(await sendRequestedJobCancellation(access, "i", { getAccessToken: token(), sendOnce }))
      .toMatchObject({ state: "observation-required" });
    expect(sendOnce).toHaveBeenCalledTimes(1); expect(await held()).toEqual(before);
  });
});
