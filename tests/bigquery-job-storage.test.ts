import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { observePreparedIntentJob, prepareIntentJob } from "../lib/bigquery-job-storage";
import { dispatchPreparedMetricRead } from "../lib/dispatch-authority";
import { stopBeforeDispatch } from "../lib/pre-dispatch-stop";
import { retireSemanticRelease } from "../lib/semantic-candidate-storage";
import { dispatchBigQueryMetricRead } from "../lib/bigquery-governed-transport";
import revenue from "./fixtures/revenue-metric.json";
import type { ControlAccess } from "../lib/control-storage";
import type { D1Database, D1Value } from "../lib/d1";
import { jobSqlite } from "./fixtures/job-sqlite";

const target = { BIGQUERY_PROJECT_ID: "demo-project", BIGQUERY_LOCATION: "US" };
let dir: string;
let dbName: string;
let access: ControlAccess;
let beforeClaim: (() => Promise<unknown>) | undefined;
let claimMode: "run" | "run-after-expiry" | "run-after-price-expiry";

async function sqlite(mode: string, sql = "", params: D1Value[] = []) {
  return jobSqlite(join(dir, dbName), mode, sql, params);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "odap-binding-"));
  dbName = "test.db";
  await sqlite("setup");
  beforeClaim = undefined;
  claimMode = "run";
  const db = { prepare: (sql: string) => ({ bind: (...params: D1Value[]) => ({
    first: () => sqlite("first", sql, params), run: async () => {
      if (!sql.startsWith("INSERT INTO dispatch_claims")) return sqlite("run", sql, params);
      await beforeClaim?.();
      return sqlite(claimMode, sql, params);
    }
  }) }) } as D1Database;
  access = { db, tenantId: "t", principalId: "owner" };
});

async function prepareDispatchFixture() {
  await prepareIntentJob(access, "i", target);
  await sqlite("run", "INSERT INTO dispatch_targets VALUES('t','orders','r','p1','s1','demo-project','US')");
  await sqlite("run", "INSERT INTO dispatch_read_grants VALUES('t','orders','user','agent','p1')");
}

it("upgrades actual v6 claims without fabricating their historical ceiling", async () => {
  dbName = "legacy.db";
  await sqlite("setup-v6");
  await prepareDispatchFixture();
  await sqlite("run", "INSERT INTO dispatch_claims(tenant_id,intent_id,claimed_by) VALUES('t','i','owner')");
  await sqlite("apply-scan-limits");
  expect(await sqlite("first", "SELECT claimed_by,maximum_bytes_billed FROM dispatch_claims"))
    .toEqual({ claimed_by: "owner", maximum_bytes_billed: null });
  await expect(sqlite("run", "UPDATE dispatch_claims SET maximum_bytes_billed=1")).rejects.toThrow("immutable");
  await expect(sqlite("run", "INSERT INTO dispatch_claims(tenant_id,intent_id,claimed_by) VALUES('t','new','owner')"))
    .rejects.toThrow("requires byte ceiling");
  await sqlite("apply-terminal-observations");
  await expect(sqlite("run", `INSERT INTO bigquery_terminal_observations
    (tenant_id,intent_id,outcome,billed_bytes,has_bytes,observed_by)
    VALUES('t','i','succeeded',NULL,0,'owner')`)).rejects.toThrow("terminal observation denied");
  expect(await sqlite("first", "SELECT count(*) AS samples FROM bigquery_terminal_observations")).toEqual({ samples: 0 });
}, 20_000);

it("upgrades an existing retirement without assigning an owner, time or new event to the old decision", async () => {
  dbName = "retired-v16.db";
  await sqlite("setup-v16");
  await sqlite("run", "INSERT INTO dispatch_retired_releases VALUES('t','r','historic')");
  await sqlite("apply-semantic-retirement");
  expect(await retireSemanticRelease(access, "r", "retry")).toEqual({ status: "legacy_retired" });
  expect(await sqlite("first", "SELECT reason,retired_by,retired_at FROM dispatch_retired_releases"))
    .toEqual({ reason: "historic", retired_by: null, retired_at: null });
  expect(await sqlite("first", "SELECT count(*) AS n FROM control_object_events WHERE object_kind='semantic_release_retirement'"))
    .toEqual({ n: 0 });
});

it("does not fall back to a default price or a different revision or region", async () => {
  await prepareDispatchFixture();
  const adapter = { projectId: "demo-project", location: "US", loadDefinition: vi.fn(), prepareRead: vi.fn() };
  const dispatch = () => dispatchPreparedMetricRead(access, "i", { principalId: "user", agentId: "agent" },
    { target: "orders", metricId: "revenue", parameters: { year: 2026 } }, adapter);
  await expect(dispatch()).rejects.toThrow("Dispatch authority unavailable");
  const addPolicy = (revision: string, location: string, mode: string) => sqlite("run",
    `INSERT INTO bigquery_scan_policies VALUES('t','orders',?,'demo-project',?,?,1,5000,'2080-01-01T00:00:00.000Z','test')`,
    [revision, location, mode]);
  await expect(addPolicy("p1", "US", "capacity")).rejects.toThrow("CHECK");
  await addPolicy("p2", "US", "on_demand");
  await addPolicy("p1", "EU", "on_demand");
  await expect(dispatch()).rejects.toThrow("Dispatch authority unavailable");
  expect(adapter.prepareRead).not.toHaveBeenCalled();
  expect(await sqlite("first", "SELECT count(*) AS n FROM dispatch_claims")).toEqual({ n: 0 });
}, 20_000);

describe("final dispatch gate", { timeout: 20_000 }, () => {
  const agent = { principalId: "user", agentId: "agent" };
  const action = { target: "orders", metricId: "revenue", parameters: { year: 2026 } };
  const submitRead = vi.fn<(job: unknown) => Promise<string>>();
  const loadDefinition = vi.fn<() => Promise<string>>();
  const adapter = { projectId: "demo-project", location: "US", loadDefinition,
    prepareRead: async (job: unknown) => () => submitRead(job) };
  const dispatch = () => dispatchPreparedMetricRead(access, "i", agent, action, adapter);

  beforeEach(async () => {
    submitRead.mockReset().mockResolvedValue("submitted");
    loadDefinition.mockReset().mockResolvedValue(JSON.stringify(revenue));
    await prepareDispatchFixture();
    await sqlite("run", `INSERT INTO bigquery_scan_policies VALUES
      ('t','orders','p1','demo-project','US','on_demand',262144,100000000,'2080-01-01T00:00:00.000Z','synthetic fixture')`);
  });

  function wire() {
    return { projectId: "demo-project", location: "US", maxBytesBilled: 1048576, loadDefinition,
      getAccessToken: vi.fn(async () => "offline-fixture"), sendOnce: vi.fn<(request: Request) => Promise<Response>>() };
  }

  it("constructs exactly one bounded jobs.insert after the claim, with no result data or implicit network", async () => {
    const t = wire();
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network not allowed"));
    const prepared = await prepareIntentJob(access, "i", target);
    t.sendOnce.mockImplementationOnce(async req => {
      expect(req.method).toBe("POST");
      expect(req.redirect).toBe("manual");
      const url = new URL(req.url);
      expect(url.origin + url.pathname).toBe("https://bigquery.googleapis.com/bigquery/v2/projects/demo-project/jobs");
      expect(req.headers.get("authorization")).toBe("Bearer offline-fixture");
      const body = await req.json();
      expect(body).toEqual({ jobReference: prepared.identity.jobReference, configuration: {
        labels: prepared.identity.labels, query: {
          query: "SELECT SUM(`net_amount`) AS metric_value FROM `demo-project.analytics.orders` WHERE `order_year` = @p0",
          useLegacySql: false, parameterMode: "NAMED", maximumBytesBilled: "1048576",
          queryParameters: [{ name: "p0", parameterType: { type: "INT64" }, parameterValue: { value: "2026" } }]
        }
      } });
      expect(await sqlite("first", "SELECT maximum_bytes_billed AS cap FROM dispatch_claims")).toEqual({ cap: 1048576 });
      return Response.json({ ...body, configuration: { ...body.configuration, jobType: "QUERY" } });
    });
    const result = await dispatchBigQueryMetricRead(access, "i", agent, action, t);
    expect(result).toEqual({ state: "accepted", jobReference: prepared.identity.jobReference });
    await expect(dispatchBigQueryMetricRead(access, "i", agent, action, t)).rejects.toThrow("already claimed");
    expect(t.getAccessToken).toHaveBeenCalledTimes(1);
    expect(t.sendOnce).toHaveBeenCalledTimes(1);
    expect(network).not.toHaveBeenCalled();
  });

  it("does not claim when authentication fails and rechecks authorization after token acquisition", async () => {
    const t = wire();
    await expect(dispatchBigQueryMetricRead(access, "i", agent, action, { ...t, maxBytesBilled: 0 }))
      .rejects.toThrow("Explicit transport byte ceiling required");
    expect(t.getAccessToken).not.toHaveBeenCalled();
    t.getAccessToken.mockRejectedValueOnce(new Error("sensitive provider detail"));
    await expect(dispatchBigQueryMetricRead(access, "i", agent, action, t)).rejects.toThrow(/^BigQuery transport authentication unavailable$/);
    t.getAccessToken.mockImplementationOnce(async () => {
      await sqlite("run", "DELETE FROM dispatch_read_grants");
      return "offline-fixture";
    });
    await expect(dispatchBigQueryMetricRead(access, "i", agent, action, t)).rejects.toThrow("Dispatch denied");
    expect(t.getAccessToken).toHaveBeenCalledTimes(2);
    expect(t.sendOnce).not.toHaveBeenCalled();
    expect(await sqlite("first", "SELECT count(*) AS n FROM dispatch_claims")).toEqual({ n: 0 });
  });

  it.each(["duplicate", "timeout", "invalid-json", "wrong-id", "wrong-label", "changed-cap",
    "redirect-301", "redirect-302", "redirect-303", "redirect-307", "redirect-308"])(
    "requires observation and never rearms a claim after %s", async failure => {
      const t = wire();
      t.sendOnce.mockImplementationOnce(async req => {
        if (failure.startsWith("redirect-")) return new Response("not-json", {
          status: Number(failure.slice("redirect-".length)), headers: { Location: "https://fixture.invalid/collect" }
        });
        if (failure === "duplicate") return new Response(null, { status: 409 });
        if (failure === "timeout") throw new Error("timeout");
        if (failure === "invalid-json") return new Response("invalid");
        const job = await req.json();
        job.configuration.jobType = "QUERY";
        if (failure === "wrong-id") job.jobReference.jobId = "different";
        if (failure === "wrong-label") job.configuration.labels.odap_action = "different";
        if (failure === "changed-cap") job.configuration.query.maximumBytesBilled = "999999999";
        return Response.json(job);
      });
      expect((await dispatchBigQueryMetricRead(access, "i", agent, action, t)).state).toBe("observation-required");
      await expect(dispatchBigQueryMetricRead(access, "i", agent, action, t)).rejects.toThrow("already claimed");
      expect(t.sendOnce).toHaveBeenCalledTimes(1);
      expect(await sqlite("first", "SELECT reserved_units,spent_units FROM control_budgets"))
        .toEqual({ reserved_units: 20, spent_units: 0 });
    });

  it("hands the exact bound read to one adapter across parallel attempts", async () => {
    const attempts = await Promise.allSettled([dispatch(), dispatch(), dispatch()]);
    expect(attempts.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(submitRead).toHaveBeenCalledTimes(1);
    expect(submitRead).toHaveBeenCalledWith(expect.objectContaining({
      queryConfig: { query: "SELECT SUM(`net_amount`) AS metric_value FROM `demo-project.analytics.orders` WHERE `order_year` = @p0",
        useLegacySql: false, parameterMode: "NAMED", maximumBytesBilled: "83886080",
        queryParameters: [{ name: "p0", parameterType: { type: "INT64" }, parameterValue: { value: "2026" } }] },
      release: expect.objectContaining({ id: "r", definitionDigest: expect.stringMatching(/^sha256:/) }),
      identity: expect.objectContaining({ jobReference: expect.objectContaining({ jobId: expect.stringMatching(/^odap_/) }) })
    }));
    expect(await sqlite("first", "SELECT maximum_bytes_billed AS cap FROM dispatch_claims")).toEqual({ cap: 83886080 });
    await expect(sqlite("run", `INSERT OR REPLACE INTO dispatch_claims(tenant_id,intent_id,claimed_by,maximum_bytes_billed)
      VALUES('t','i','owner',99999999)`)).rejects.toThrow("immutable dispatch claim");
  });

  it("declines a rate that expires after compilation, without a claim or adapter call", async () => {
    claimMode = "run-after-price-expiry";
    await expect(dispatch()).rejects.toThrow("Dispatch denied");
    expect(loadDefinition).toHaveBeenCalled();
    expect(submitRead).not.toHaveBeenCalled();
    expect(await sqlite("first", "SELECT count(*) AS n FROM dispatch_claims")).toEqual({ n: 0 });
  });

  it("cannot rewrite the policy rate, cap or scope at the old revision", async () => {
    await expect(sqlite("run", "UPDATE bigquery_scan_policies SET micro_usd_per_tib=1")).rejects.toThrow("immutable scan policy");
    await expect(sqlite("run", "DELETE FROM bigquery_scan_policies")).rejects.toThrow("immutable scan policy");
    await expect(sqlite("run", `INSERT OR REPLACE INTO bigquery_scan_policies VALUES
      ('t','orders','p1','other-project','EU','on_demand',1,999999999,'2099-01-01T00:00:00.000Z','replacement')`))
      .rejects.toThrow("immutable scan policy");
  });

  it("does not consume the claim for a missing or substituted metric definition", async () => {
    loadDefinition.mockRejectedValueOnce(new Error("not found")).mockResolvedValueOnce(JSON.stringify({
      ...revenue, measure: { aggregate: "SUM", column: "gross_amount" }
    }));
    await expect(dispatch()).rejects.toThrow("not found");
    await expect(dispatch()).rejects.toThrow("Metric release mismatch");
    expect(loadDefinition).toHaveBeenCalledWith({ tenantId: "t", releaseId: "r" });
    expect(submitRead).not.toHaveBeenCalled();
    expect(await sqlite("first", "SELECT count(*) AS n FROM dispatch_claims")).toEqual({ n: 0 });
    await expect(dispatch()).resolves.toBe("submitted");
  });

  it.each([
    ["original membership", "UPDATE control_memberships SET active=0 WHERE principal_id='user'"],
    ["operator role", "UPDATE control_memberships SET role='reader' WHERE principal_id='owner'"],
    ["grant", "DELETE FROM dispatch_read_grants"],
    ["policy revision", "UPDATE dispatch_targets SET policy_revision='p2'"],
    ["source revision", "UPDATE dispatch_targets SET source_revision='s2'"],
    ["project mapping", "UPDATE dispatch_targets SET project_id='another'"],
    ["budget overrun", "UPDATE control_budgets SET overrun_units=1"]
  ])("denies changes to %s between preflight and claim", async (_name, sql) => {
    beforeClaim = () => sqlite("run", sql);
    await expect(dispatch()).rejects.toThrow("Dispatch denied");
    expect(submitRead).not.toHaveBeenCalled();
    expect(await sqlite("first", "SELECT count(*) AS n FROM dispatch_claims")).toEqual({ n: 0 });
  });

  it("blocks a dispatch when the owner retires its release between preflight and the final claim", async () => {
    beforeClaim = async () => { expect(await retireSemanticRelease(access, "r", "superseded")).toMatchObject({ status: "retired" }); };
    await expect(dispatch()).rejects.toThrow("Dispatch denied");
    expect(submitRead).not.toHaveBeenCalled();
    await expect(sqlite("run", `INSERT INTO dispatch_claims(tenant_id,intent_id,claimed_by,maximum_bytes_billed)
      VALUES('t','i','owner',1)`)).rejects.toThrow("semantic release retired");
    expect(await sqlite("first", `SELECT (SELECT count(*) FROM dispatch_claims) AS claims,
      reserved_units,spent_units FROM control_budgets`)).toEqual({ claims: 0, reserved_units: 20, spent_units: 0 });
  });

  it("does not cancel a previously claimed handoff, settle its budget or replace the first retirement", async () => {
    await expect(dispatch()).resolves.toBe("submitted");
    const first = await retireSemanticRelease(access, "r", "first reason");
    if (first.status !== "retired") throw new Error("Retirement not recorded");
    expect(await retireSemanticRelease(access, "r", "replacement")).toEqual({ status: "already_retired", retiredAt: first.retiredAt });
    expect(await sqlite("first", `SELECT reason,retired_by,retired_at FROM dispatch_retired_releases`))
      .toEqual({ reason: "first reason", retired_by: "owner", retired_at: first.retiredAt });
    expect(await sqlite("first", `SELECT (SELECT count(*) FROM dispatch_claims) AS claims,
      (SELECT count(*) FROM bigquery_cancellation_requests) AS cancellations,
      (SELECT count(*) FROM control_object_events WHERE object_kind='semantic_release_retirement') AS events,
      reserved_units,spent_units FROM control_budgets`))
      .toEqual({ claims: 1, cancellations: 0, events: 1, reserved_units: 20, spent_units: 0 });
    await expect(dispatch()).rejects.toThrow();
    expect(submitRead).toHaveBeenCalledTimes(1);
  });

  it("orders retirement against the actual final dispatch claim on separate connections", async () => {
    const ready = new Promise<void>(resolve => { beforeClaim = async () => resolve(); });
    const [handoff, retirement] = await Promise.allSettled([dispatch(), ready.then(() => retireSemanticRelease(access, "r", "race"))]);
    expect(retirement).toMatchObject({ status: "fulfilled", value: { status: "retired" } });
    const claimed = handoff.status === "fulfilled";
    if (!claimed) expect(handoff.reason.message).toContain("Dispatch denied");
    expect(submitRead).toHaveBeenCalledTimes(Number(claimed));
    expect(await sqlite("first", `SELECT (SELECT count(*) FROM dispatch_claims) AS claims,
      (SELECT count(*) FROM dispatch_retired_releases) AS markers`)).toEqual({ claims: Number(claimed), markers: 1 });
  });

  it("does not hand off a prepared read when an owner stops it immediately before the final claim", async () => {
    beforeClaim = async () => {
      expect(await stopBeforeDispatch(access, "i")).toMatchObject({ state: "stopped", stoppedBy: "owner" });
    };
    await expect(dispatch()).rejects.toThrow("Dispatch denied");
    expect(submitRead).not.toHaveBeenCalled();
    await expect(sqlite("run", `INSERT INTO dispatch_claims(tenant_id,intent_id,claimed_by,maximum_bytes_billed)
      VALUES('t','i','owner',1)`)).rejects.toThrow("dispatch stopped");
    expect(await sqlite("first", `SELECT (SELECT count(*) FROM dispatch_claims) AS claims,
      (SELECT count(*) FROM cost_settlements) AS settlements,
      (SELECT json_extract(payload,'$.outcome') FROM evidence_receipts) AS receipt,
      reserved_units,spent_units FROM control_budgets`))
      .toEqual({ claims: 0, settlements: 0, receipt: "pending", reserved_units: 20, spent_units: 0 });
  });

  it("serializes a stop racing the real final claim on separate SQLite connections", async () => {
    const ready = new Promise<void>(resolve => { beforeClaim = async () => resolve(); });
    const [handoff, stop] = await Promise.allSettled([dispatch(), ready.then(() => stopBeforeDispatch(access, "i"))]);
    expect(stop.status).toBe("fulfilled");
    const sent = handoff.status === "fulfilled";
    expect(stop).toMatchObject({ value: { state: sent ? "already-claimed" : "stopped" } });
    if (!sent) expect(handoff.reason.message).toContain("Dispatch denied");
    expect(submitRead).toHaveBeenCalledTimes(sent ? 1 : 0);
    expect(await sqlite("first", `SELECT (SELECT count(*) FROM dispatch_claims) AS claims,
      (SELECT count(*) FROM dispatch_stopped_intents) AS stops,reserved_units,spent_units FROM control_budgets`))
      .toEqual({ claims: Number(sent), stops: Number(!sent), reserved_units: 20, spent_units: 0 });
  });

  it("does not carry authority over to a newer policy or a replacement semantic release", async () => {
    await sqlite("run", "INSERT INTO dispatch_read_grants VALUES('t','orders','user','agent','p2')");
    beforeClaim = () => sqlite("run", "UPDATE dispatch_targets SET policy_revision='p2'");
    await expect(dispatch()).rejects.toThrow("Dispatch denied");
    await sqlite("run", "UPDATE dispatch_targets SET policy_revision='p1'");
    await sqlite("run", `INSERT INTO semantic_releases(tenant_id,id,payload,created_by)
      SELECT tenant_id,'r2',json_set(payload,'$.id','r2','$.definitionDigest','changed'),created_by FROM semantic_releases WHERE id='r'`);
    beforeClaim = () => sqlite("run", "UPDATE dispatch_targets SET release_id='r2'");
    await expect(dispatch()).rejects.toThrow("Dispatch denied");
    expect(submitRead).not.toHaveBeenCalled();
  });

  it("denies expiry at the database clock and settlement after preflight", async () => {
    claimMode = "run-after-expiry";
    await expect(dispatch()).rejects.toThrow("Dispatch denied");
    claimMode = "run";
    await sqlite("run", `INSERT INTO evidence_receipts(tenant_id,id,contract_id,release_id,payload,created_by)
      VALUES('t','final','c','r',?,'owner')`, [JSON.stringify({ id: "final", tenantId: "t",
      contractId: "c", semanticReleaseId: "r", intentId: "i", outcome: "cancelled" })]);
    beforeClaim = () => sqlite("run", "INSERT INTO cost_settlements(tenant_id,intent_id,receipt_id,actual_units,actor) VALUES('t','i','final',0,'owner')");
    await expect(dispatch()).rejects.toThrow("Dispatch denied");
    expect(submitRead).not.toHaveBeenCalled();
    expect(await stopBeforeDispatch(access, "i")).toEqual({ state: "already-settled" });
    expect(await sqlite("first", "SELECT count(*) AS n FROM dispatch_stopped_intents")).toEqual({ n: 0 });
  });

  it("rejects a substituted action, principal, tenant, agent or adapter", async () => {
    await expect(dispatchPreparedMetricRead(access, "i", agent, { ...action, parameters: { year: 2025 } }, adapter)).rejects.toThrow();
    await expect(dispatchPreparedMetricRead(access, "i", { ...agent, principalId: "owner" }, action, adapter)).rejects.toThrow();
    await expect(dispatchPreparedMetricRead(access, "i", { ...agent, agentId: "other" }, action, adapter)).rejects.toThrow();
    await expect(dispatchPreparedMetricRead({ ...access, tenantId: "other" }, "i", agent, action, adapter)).rejects.toThrow();
    await expect(dispatchPreparedMetricRead(access, "i", agent, action, { ...adapter, location: "EU" })).rejects.toThrow();
    expect(submitRead).not.toHaveBeenCalled();
  });

  it("does not resubmit after an ambiguous adapter failure", async () => {
    submitRead.mockRejectedValueOnce(new Error("network timeout"));
    await expect(dispatch()).rejects.toThrow("network timeout");
    expect(await stopBeforeDispatch(access, "i")).toEqual({ state: "already-claimed" });
    expect(await sqlite("first", "SELECT count(*) AS n FROM dispatch_stopped_intents")).toEqual({ n: 0 });
    await expect(dispatch()).rejects.toThrow("already claimed");
    expect(submitRead).toHaveBeenCalledTimes(1);
  });
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
