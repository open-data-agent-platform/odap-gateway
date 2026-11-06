import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as bigquery from "../lib/bigquery";
import { reconcileBigQueryBill } from "../lib/bigquery-billing";
import { readJobCancellation, requestJobCancellation } from "../lib/bigquery-cancellation";
import { prepareIntentJob } from "../lib/bigquery-job-storage";
import { readTerminalObservation, reconcileTerminalObservation } from "../lib/bigquery-terminal-observations";
import type { ControlAccess } from "../lib/control-storage";
import type { D1Database, D1Value } from "../lib/d1";
import { exportSettledEvidence } from "../lib/settled-evidence-export";
import { buildDetachedVerifier } from "./fixtures/detached-verifier";
import { jobSqlite } from "./fixtures/job-sqlite";
import { corruptTerminalEnrichment } from "./fixtures/conflicting-terminal";

const env = { BIGQUERY_PROJECT_ID: "demo-project", BIGQUERY_LOCATION: "US",
  BIGQUERY_CLIENT_EMAIL: "fixture@example.test", BIGQUERY_PRIVATE_KEY: "unused-fixture" };
let dir: string;
let file: string;
let access: ControlAccess;
let identity: Awaited<ReturnType<typeof prepareIntentJob>>["identity"];

function sqlite(mode: string, sql = "", params: D1Value[] = []) {
  return jobSqlite(join(dir, file), mode, sql, params);
}
function claim() {
  return sqlite("run", `INSERT INTO dispatch_claims(tenant_id,intent_id,claimed_by,maximum_bytes_billed)
    VALUES('t','i','owner',128)`);
}
function resource(bytes?: string, reason?: string, state = "DONE") {
  return { jobReference: identity.jobReference, configuration: { jobType: "QUERY", labels: identity.labels,
    query: { maximumBytesBilled: "128" } }, statistics: { query: { totalBytesBilled: bytes } },
    status: { state, ...(reason !== undefined && { errorResult: { reason } }) } };
}
function lookup(makeResponse: () => Response | Promise<Response>) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options) => {
    const request = new URL(String(url));
    expect(options?.method ?? "GET").toBe("GET");
    expect(request.pathname).toBe("/bigquery/v2/projects/demo-project/jobs/" + identity.jobReference.jobId);
    expect(request.searchParams.get("fields")).toContain("query/maximumBytesBilled");
    return makeResponse();
  });
}
const record = () => reconcileTerminalObservation(access, "i", env);

describe("durable terminal warehouse evidence", { timeout: 20_000 }, () => {
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "odap-terminal-"));
    file = "test.db";
    await sqlite("setup");
    const db = { prepare: (sql: string) => ({ bind: (...params: D1Value[]) => ({
      first: () => sqlite("first", sql, params), run: () => sqlite("run", sql, params)
    }) }) } as D1Database;
    access = { db, tenantId: "t", principalId: "owner" };
    identity = (await prepareIntentJob(access, "i", env)).identity;
    vi.spyOn(bigquery, "createBigQueryAccessToken").mockResolvedValue("offline");
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected network request"));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  describe("local post-claim cancellation requests", () => {
    const request = () => requestJobCancellation(access, "i");
    const status = () => readJobCancellation(access, "i");
    it.each([false,true])("rejects contradictory restored outcomes with prior cancellation request=%s", async requested => {
      await claim();
      const original = requested ? (await request()).request : null;
      await sqlite("run", `INSERT INTO bigquery_terminal_observations
        (tenant_id,intent_id,outcome,has_bytes,observed_by) VALUES('t','i','cancelled',0,'owner')`);
      expect(await status()).toMatchObject({ state: "terminal", outcome: "cancelled", request: original });
      await corruptTerminalEnrichment((q,args) => sqlite("run",q,args), "i");
      await expect(status()).rejects.toThrow("Conflicting terminal outcomes");
      await expect(request()).rejects.toThrow("Conflicting terminal outcomes");
      expect(await sqlite("readonly-first", `SELECT requested_by AS requestedBy, requested_at AS requestedAt
        FROM bigquery_cancellation_requests WHERE tenant_id='t' AND intent_id='i'`)).toEqual(original);
      expect(await sqlite("readonly-first", `SELECT reserved_units,spent_units,(SELECT COUNT(*) FROM cost_settlements) AS settlements,
        (SELECT COUNT(*) FROM bigquery_terminal_observations) AS samples FROM control_budgets WHERE tenant_id='t' AND id='b'`))
        .toEqual({ reserved_units: 20, spent_units: 0, settlements: 0, samples: 2 });
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });
    it("verifies a cancelled job with a nonzero bill end to end, without double charging", async () => {
      await claim();
      const ledger = () => sqlite("readonly-first", `SELECT reserved_units,spent_units,
        (SELECT count(*) FROM cost_settlements) AS settlements FROM control_budgets WHERE tenant_id='t' AND id='b'`);
      const held = { reserved_units: 20, spent_units: 0, settlements: 0 };
      const requested = await request();
      expect(requested.state).toBe("requested");
      expect(await ledger()).toEqual(held);
      const loadBill = vi.fn(async () => null);
      expect(await reconcileBigQueryBill(access, "i", loadBill)).toEqual({ state: "pending-terminal" });
      expect(loadBill).not.toHaveBeenCalled();

      const http = lookup(() => Response.json(resource("47", "stopped")));
      expect(await record()).toMatchObject({ state: "cancelled", billedBytes: 47 });
      expect(await status()).toEqual({ ...requested, state: "terminal", outcome: "cancelled" });
      expect(await reconcileBigQueryBill(access, "i", loadBill)).toEqual({ state: "pending-bill" });
      expect(await exportSettledEvidence(access, "i")).toBeNull();
      expect(await ledger()).toEqual(held);

      const finalBill = async () => ({ tenantId: "t", jobReference: identity.jobReference,
        status: "final", reference: "fixture:cancel-charge", unit: "micro-USD", amount: 7 });
      const settle = () => reconcileBigQueryBill(access, "i", finalBill);
      const [first, retry] = await Promise.all([settle(), settle()]);
      expect(first).toMatchObject({ state: "settled", actualMicroUsd: 7, receipt: { outcome: "cancelled" } });
      expect(retry).toEqual(first);
      expect(await request()).toEqual({ ...requested, state: "terminal", outcome: "cancelled" });
      expect(await ledger()).toEqual({ reserved_units: 0, spent_units: 7, settlements: 1 });

      const bundle = await exportSettledEvidence(access, "i");
      if (!bundle) throw new Error("Missing settled cancellation evidence");
      expect(JSON.parse(bundle.json)).toMatchObject({ pending: { outcome: "pending" },
        job: identity.jobReference, observation: { outcome: "cancelled", billedBytes: 47 },
        bill: { reference: "fixture:cancel-charge", actualMicroUsd: 7 }, settlement: { actualMicroUsd: 7 } });
      const bundlePath = join(dir, "cancelled.json"), pinPath = join(dir, "retained.sha256");
      await writeFile(pinPath, bundle.digest, { flag: "wx" });
      await writeFile(bundlePath, bundle.json, { flag: "wx" });
      const verify = await buildDetachedVerifier(join(dir, "verifier"));
      const { stdout, stderr } = await verify(bundlePath, "t", "i", pinPath);
      expect(stderr).toBe("");
      expect(JSON.parse(stdout)).toMatchObject({ consistent: true, issuerAuthenticated: false,
        outcome: "cancelled", actualMicroUsd: 7, digest: bundle.digest });
      expect(http).toHaveBeenCalledTimes(1);
    }, 30_000);

    it("records only the first owner despite concurrent requests, retries and replacement", async () => {
      await claim();
      expect(await status()).toEqual({ state: "not-requested", request: null, jobReference: identity.jobReference });
      await sqlite("run", "INSERT INTO control_memberships VALUES('t','other-owner','owner',1)");
      const [a, b] = await Promise.all([request(), requestJobCancellation({ ...access, principalId: "other-owner" }, "i")]);
      expect(b).toEqual(a);
      expect(a).toMatchObject({ state: "requested", jobReference: identity.jobReference,
        request: { requestedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/), requestedBy: expect.stringMatching(/^(owner|other-owner)$/) } });
      await sqlite("run", `INSERT OR REPLACE INTO bigquery_cancellation_requests(tenant_id,intent_id,job_id,requested_by)
        VALUES('t','i',?,?)`, [identity.jobReference.jobId, a.request?.requestedBy === "owner" ? "other-owner" : "owner"]);
      await expect(sqlite("run", "UPDATE bigquery_cancellation_requests SET requested_by='other-owner'")).rejects.toThrow("immutable");
      await expect(sqlite("run", "DELETE FROM bigquery_cancellation_requests")).rejects.toThrow("immutable");
      expect(await request()).toEqual(a);
      expect(await sqlite("first", `SELECT (SELECT count(*) FROM bigquery_cancellation_requests) AS requests,
        (SELECT count(*) FROM dispatch_claims) AS claims,(SELECT count(*) FROM bigquery_terminal_observations) AS observations,
        (SELECT count(*) FROM cost_settlements) AS charges,(SELECT count(*) FROM evidence_receipts) AS receipts,
        (SELECT json_extract(payload,'$.outcome') FROM evidence_receipts) AS receiptState,reserved_units,spent_units FROM control_budgets`))
        .toEqual({ requests: 1, claims: 1, observations: 0, charges: 0, receipts: 1, receiptState: "pending", reserved_units: 20, spent_units: 0 });
      expect(globalThis.fetch).not.toHaveBeenCalled();
      expect(bigquery.createBigQueryAccessToken).not.toHaveBeenCalled();
    });

    it.each([["stopped", "cancelled"], ["invalidQuery", "failed"], [undefined, "succeeded"]])(
      "reports the observed outcome after a request, even if cancellation lost the race (%s)", async (reason, outcome) => {
        await claim();
        const pending = await request();
        const wrong = resource("9", "stopped");
        lookup(() => Response.json({ ...wrong, jobReference: { ...identity.jobReference, jobId: "wrong_job" } }));
        await expect(record()).rejects.toThrow("Unmatched BigQuery job");
        expect(await status()).toEqual(pending);
        lookup(() => Response.json(resource("9", reason)));
        await record();
        expect(await request()).toEqual({ ...pending, state: "terminal", outcome });
      });

    it("does not create a late request after an already completed job", async () => {
      await claim();
      lookup(() => Response.json(resource("7")));
      await record();
      expect(await request()).toEqual({ state: "terminal", outcome: "succeeded", jobReference: identity.jobReference, request: null });
      expect(await sqlite("first", "SELECT count(*) AS n FROM bigquery_cancellation_requests")).toEqual({ n: 0 });
    });

    it("denies pre-claim, wrong job, wrong tenant and inactive or non-owner requests", async () => {
      await expect(request()).rejects.toThrow("unavailable");
      await claim();
      for (const scope of [{ ...access, tenantId: "other" }, { ...access, principalId: "user" }]) {
        await expect(requestJobCancellation(scope, "i")).rejects.toThrow("unavailable");
        await expect(readJobCancellation(scope, "i")).rejects.toThrow("unavailable");
      }
      const insert = (job: string, owner: string) => sqlite("run", `INSERT INTO bigquery_cancellation_requests
        (tenant_id,intent_id,job_id,requested_by) VALUES('t','i',?,?)`, [job, owner]);
      await expect(insert("wrong_job", "owner")).rejects.toThrow("unavailable");
      await sqlite("run", "UPDATE control_memberships SET active=0 WHERE principal_id='owner'");
      await expect(insert(identity.jobReference.jobId, "owner")).rejects.toThrow("unavailable");
      expect(await sqlite("first", "SELECT count(*) AS n FROM bigquery_cancellation_requests")).toEqual({ n: 0 });
    });

    it("preserves a legacy settlement without inventing a request or warehouse outcome on upgrade", async () => {
      file = "v8.db";
      await sqlite("setup-v8");
      await prepareIntentJob(access, "i", env);
      await claim();
      await sqlite("run", `INSERT INTO evidence_receipts(tenant_id,id,contract_id,release_id,payload,created_by)
        VALUES('t','legacy','c','r',?,'owner')`, [JSON.stringify({ id: "legacy", schemaVersion: "0.1", tenantId: "t",
        contractId: "c", semanticReleaseId: "r", intentId: "i", outcome: "cancelled",
        reason: "fixture", recordedAt: "2026-01-01T00:00:00.000Z" })]);
      await sqlite("run", "INSERT INTO cost_settlements(tenant_id,intent_id,receipt_id,actual_units,actor) VALUES('t','i','legacy',7,'owner')");
      for (const step of ["apply-billing-evidence", "apply-preapproval-denials", "apply-pre-dispatch-stop", "apply-cancellation-requests"]) {
        await sqlite(step);
      }
      expect(await request()).toEqual({ state: "settled-unverified", jobReference: identity.jobReference, request: null });
      expect(await sqlite("first", "SELECT count(*) AS n FROM bigquery_cancellation_requests")).toEqual({ n: 0 });
    });
  });

  it("keeps a terminal outcome across restarts and enriches unknown bytes once without settling", async () => {
    await claim();
    let bytes: string | undefined;
    const http = lookup(() => Response.json(resource(bytes)));
    const [first, replay] = await Promise.all([record(), record()]);
    expect(first).toMatchObject({ state: "succeeded", billedBytes: null, observedBy: "owner" });
    expect(replay).toEqual(first);
    expect(await readTerminalObservation(access, "i")).toEqual(first);
    expect(await readTerminalObservation({ ...access, tenantId: "other" }, "i")).toBeNull();
    expect(await readTerminalObservation({ ...access, principalId: "user" }, "i")).toBeNull();
    expect(http).toHaveBeenCalledTimes(2);
    bytes = "0";
    const [known, duplicate] = await Promise.all([record(), record()]);
    expect(known).toMatchObject({ state: "succeeded", billedBytes: 0 });
    expect(duplicate).toEqual(known);
    bytes = undefined;
    expect(await record()).toEqual(known);
    lookup(() => new Response(null, { status: 404 }));
    expect(await record()).toEqual(known);
    expect(await sqlite("first", `SELECT (SELECT count(*) FROM bigquery_terminal_observations) AS samples,
      (SELECT count(*) FROM cost_settlements) AS charges,(SELECT count(*) FROM evidence_receipts) AS receipts,
      (SELECT json_extract(payload,'$.outcome') FROM evidence_receipts) AS receiptState,
      reserved_units,spent_units FROM control_budgets`)).toEqual({
      samples: 2, charges: 0, receipts: 1, receiptState: "pending", reserved_units: 20, spent_units: 0
    });
  });

  it.each([["stopped", "cancelled"], ["invalidQuery", "failed"]])(
    "keeps %s evidence when later samples contradict its outcome or byte count", async (reason, state) => {
      await claim();
      lookup(() => Response.json(resource("17", reason)));
      const first = await record();
      expect(first).toMatchObject({ state, billedBytes: 17 });
      lookup(() => Response.json(resource("17")));
      await expect(record()).rejects.toThrow("conflicting terminal observation");
      lookup(() => Response.json(resource("18", reason)));
      await expect(record()).rejects.toThrow("conflicting terminal observation");
      await expect(sqlite("run", "DELETE FROM bigquery_terminal_observations")).rejects.toThrow("immutable");
      await expect(sqlite("run", "UPDATE bigquery_terminal_observations SET observed_at='changed'")).rejects.toThrow("immutable");
      await sqlite("run", `INSERT OR REPLACE INTO bigquery_terminal_observations
        (tenant_id,intent_id,outcome,billed_bytes,has_bytes,observed_by,observed_at)
        SELECT tenant_id,intent_id,outcome,billed_bytes,has_bytes,observed_by,'changed' FROM bigquery_terminal_observations`);
      expect(await readTerminalObservation(access, "i")).toEqual(first);
    });

  it("never promotes missing, running, mismatched or malformed lookup results", async () => {
    await claim();
    lookup(() => new Response(null, { status: 404 }));
    expect(await record()).toBeNull();
    lookup(() => Response.json(resource(undefined, undefined, "RUNNING")));
    expect(await record()).toBeNull();
    const base = resource();
    for (const configuration of [{ ...base.configuration, query: { maximumBytesBilled: "129" } },
      { ...base.configuration, query: {} }, { ...base.configuration, labels: {} }]) {
      lookup(() => Response.json({ ...base, configuration }));
      await expect(record()).rejects.toThrow("Unmatched BigQuery job");
    }
    lookup(() => Response.json(resource(undefined, " ")));
    await expect(record()).rejects.toThrow("Malformed BigQuery terminal status");
    expect(await readTerminalObservation(access, "i")).toBeNull();
  });

  it("requires a claim and an active tenant owner before lookup and again at write time", async () => {
    await expect(record()).rejects.toThrow("Bounded dispatch claim unavailable");
    await claim();
    for (const scope of [{ ...access, tenantId: "another" }, { ...access, principalId: "user" }]) {
      await expect(reconcileTerminalObservation(scope, "i", env)).rejects.toThrow("unavailable");
    }
    expect(bigquery.createBigQueryAccessToken).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    lookup(async () => {
      await sqlite("run", "UPDATE control_memberships SET active=0 WHERE principal_id='owner'");
      return Response.json(resource("0"));
    });
    await expect(record()).rejects.toThrow("terminal observation denied");
    expect(await sqlite("first", "SELECT count(*) AS n FROM bigquery_terminal_observations")).toEqual({ n: 0 });
  });
});
