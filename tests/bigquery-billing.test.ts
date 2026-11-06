import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reconcileBigQueryBill } from "../lib/bigquery-billing";
import { prepareIntentJob } from "../lib/bigquery-job-storage";
import { isEvidenceReceipt } from "../lib/control-objects";
import type { ControlAccess } from "../lib/control-storage";
import type { D1Database, D1Value } from "../lib/d1";
import { jobSqlite } from "./fixtures/job-sqlite";
import { corruptTerminalEnrichment } from "./fixtures/conflicting-terminal";

let dir: string;
let dbFile: string;
let access: ControlAccess;
let job: Awaited<ReturnType<typeof prepareIntentJob>>;
function sqlite(mode: string, sql = "", params: D1Value[] = []) {
  return jobSqlite(join(dir, dbFile), mode, sql, params);
}
async function prepareClaim() {
  job = await prepareIntentJob(access, "i", { BIGQUERY_PROJECT_ID: "demo-project", BIGQUERY_LOCATION: "US" });
  await sqlite("run", `INSERT INTO dispatch_claims(tenant_id,intent_id,claimed_by,maximum_bytes_billed)
    VALUES('t','i','owner',1024)`);
}
async function legacyReceipt() {
  await sqlite("run", `INSERT INTO evidence_receipts(tenant_id,id,release_id,contract_id,payload,created_by)
    SELECT tenant_id,'legacy',release_id,contract_id,json_set(payload,'$.id','legacy','$.outcome','succeeded'),'owner'
    FROM evidence_receipts WHERE id=?`, [job.receipt.id]);
}
function terminal(outcome = "succeeded") {
  return sqlite("run", `INSERT INTO bigquery_terminal_observations
    (tenant_id,intent_id,outcome,has_bytes,billed_bytes,observed_by) VALUES('t','i',?,1,700,'owner')`, [outcome]);
}
function charge(amount = 12) {
  return { tenantId: "t", jobReference: job.identity.jobReference, reference: "fixture:charge-01",
    status: "final", unit: "micro-USD", amount };
}
function ledger() {
  return sqlite("first", `SELECT reserved_units,spent_units,overrun_units,
    (SELECT count(*) FROM cost_settlements) AS settlements,
    (SELECT count(*) FROM bigquery_billing_evidence) AS bills,
    (SELECT count(*) FROM evidence_receipts) AS receipts,
    (SELECT count(*) FROM control_object_events WHERE object_kind='receipt') AS events
    FROM control_budgets`);
}
const untouched = { reserved_units: 20, spent_units: 0, overrun_units: 0, settlements: 0,
  bills: 0, receipts: 1, events: 1 };
const reconcile = (bill: unknown) => reconcileBigQueryBill(access, "i", async () => bill);

describe("final per-job monetary evidence (offline)", { timeout: 20_000 }, () => {
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "odap-bill-"));
    dbFile = "billing.db";
    await sqlite("setup");
    const db = { prepare: (sql: string) => ({ bind: (...params: D1Value[]) => ({
      first: () => sqlite("first", sql, params), run: () => sqlite("run", sql, params)
    }) }) } as D1Database;
    access = { db, tenantId: "t", principalId: "owner" };
    await prepareClaim();
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it.each(["before", "during-final", "during-null"])("refuses a terminal conflict: %s", async phase => {
    await sqlite("run", `INSERT INTO bigquery_terminal_observations
      (tenant_id,intent_id,outcome,has_bytes,observed_by) VALUES('t','i','succeeded',0,'owner')`);
    const corrupt = () => corruptTerminalEnrichment((q,args) => sqlite("run",q,args), "i");
    if (phase === "before") await corrupt();
    const load = vi.fn(async () => {
      if (phase !== "before") await corrupt();
      return phase === "during-null" ? null : charge();
    });
    await expect.soft(reconcileBigQueryBill(access,"i",load)).rejects.toThrow(/conflicting terminal outcomes/i);
    expect.soft(load).toHaveBeenCalledTimes(Number(phase !== "before"));
    if (phase === "before") {
      await expect(sqlite("run", `INSERT INTO bigquery_billing_evidence
        (tenant_id,intent_id,receipt_id,evidence_ref,actual_micro_usd,actor)
        VALUES('t','i',?,'fixture:direct',12,'owner')`, ["final_" + job.identity.jobReference.jobId]))
        .rejects.toThrow("conflicting terminal outcomes");
    }
    expect(await ledger()).toEqual(untouched);
  });

  it("withholds a prior settlement when terminal evidence changes during a missing-charge retry", async () => {
    await sqlite("run", `INSERT INTO bigquery_terminal_observations
      (tenant_id,intent_id,outcome,has_bytes,observed_by) VALUES('t','i','succeeded',0,'owner')`);
    expect(await reconcile(charge())).toMatchObject({ state: "settled", actualMicroUsd: 12 });
    const settledLedger = await ledger();
    await expect(reconcileBigQueryBill(access,"i",async () => {
      await corruptTerminalEnrichment((q,args) => sqlite("run",q,args), "i");
      return null;
    })).rejects.toThrow("Conflicting terminal outcomes");
    expect(await ledger()).toEqual(settledLedger);
  });

  it("does not ask for a bill before terminal evidence, nor infer cost from measured bytes", async () => {
    const load = vi.fn(async () => null);
    expect(await reconcileBigQueryBill(access, "i", load)).toEqual({ state: "pending-terminal" });
    expect(load).not.toHaveBeenCalled();
    await terminal();
    expect(await reconcileBigQueryBill(access, "i", load)).toEqual({ state: "pending-bill" });
    expect(load).toHaveBeenCalledWith({ tenantId: "t", jobReference: job.identity.jobReference });
    expect(await ledger()).toEqual(untouched);
  });

  it.each([["succeeded", 12], ["cancelled", 0], ["failed", 125]] as const)(
    "issues one %s receipt with an explicit %i micro-USD charge across racing retries", async (outcome, amount) => {
      await terminal(outcome);
      const results = await Promise.all([reconcile(charge(amount)), reconcile(charge(amount)), reconcile(charge(amount))]);
      const saved = results[0];
      expect(results).toEqual([saved, saved, saved]);
      expect(saved).toMatchObject({ state: "settled", actualMicroUsd: amount, reference: "fixture:charge-01",
        receipt: { tenantId: "t", id: "final_" + job.identity.jobReference.jobId,
          intentId: "i", contractId: "c", semanticReleaseId: "r", outcome } });
      expect(saved.state === "settled" && isEvidenceReceipt(saved.receipt)).toBe(true);
      expect(await reconcile(null)).toEqual(saved);
      await expect(reconcile(charge(amount + 1))).rejects.toThrow("conflict");
      await expect(reconcile({ ...charge(amount), reference: "fixture:other" })).rejects.toThrow("conflict");
      expect(await sqlite("first", "SELECT payload FROM evidence_receipts WHERE id=?", [job.receipt.id]))
        .toEqual({ payload: JSON.stringify(job.receipt) });
      expect(await ledger()).toEqual({ reserved_units: 0, spent_units: Math.min(amount, 100),
        overrun_units: Math.max(0, amount - 100), bills: 1, settlements: 1, receipts: 2, events: 2 });
    });

  it("rejects substituted bindings, estimates, unsupported units and malformed amounts", async () => {
    await terminal();
    const bill = charge();
    for (const override of [{ tenantId: "other" }, { unit: "USD" }, { status: "estimated" },
      { amount: null }, { amount: 0.1 }, { amount: -1 }, { amount: Number.MAX_SAFE_INTEGER + 1 },
      { reference: "" }, ...["jobId", "projectId", "location"].map(k => ({
        jobReference: { ...bill.jobReference, [k]: "other" }
      }))]) {
      await expect(reconcile({ ...bill, ...override })).rejects.toThrow("Invalid final job charge");
    }
    expect(await ledger()).toEqual(untouched);
  });

  it("does not disclose the lookup key without owner access and rejects revocation during lookup", async () => {
    await terminal();
    const load = vi.fn(async () => {
      await sqlite("run", "UPDATE control_memberships SET active=0 WHERE principal_id='owner'");
      return charge();
    });
    for (const scope of [{ ...access, principalId: "user" }, { ...access, tenantId: "other" }]) {
      await expect(reconcileBigQueryBill(scope, "i", load)).rejects.toThrow("unavailable");
    }
    expect(load).not.toHaveBeenCalled();
    await expect(reconcileBigQueryBill(access, "i", load)).rejects.toThrow("billing evidence denied");
    expect(await ledger()).toEqual(untouched);
  });

  it("rolls back evidence, receipt, audit event and budget together and can retry safely", async () => {
    await terminal();
    await sqlite("run", `CREATE TRIGGER fail_ledger BEFORE UPDATE ON control_budgets
      BEGIN SELECT RAISE(ABORT,'simulated ledger failure'); END`);
    await expect(reconcile(charge())).rejects.toThrow("simulated ledger failure");
    expect(await ledger()).toEqual(untouched);
    await sqlite("run", "DROP TRIGGER fail_ledger");
    expect(await reconcile(charge())).toMatchObject({ state: "settled", actualMicroUsd: 12 });
  });

  it("blocks generic settlement of a claimed job and replacement of committed evidence", async () => {
    await terminal();
    const finalId = "final_" + job.identity.jobReference.jobId;
    await expect(sqlite("run", `INSERT INTO evidence_receipts(tenant_id,id,release_id,contract_id,payload,created_by)
      SELECT tenant_id,?,release_id,contract_id,json_set(payload,'$.id',?,'$.outcome','succeeded'),'owner'
      FROM evidence_receipts WHERE id=?`, [finalId, finalId, job.receipt.id])).rejects.toThrow("billing evidence required");
    await legacyReceipt();
    await expect(sqlite("run", `INSERT INTO cost_settlements(tenant_id,intent_id,receipt_id,actual_units,actor)
      VALUES('t','i','legacy',12,'owner')`)).rejects.toThrow("billing evidence required");
    await reconcile(charge());
    for (const [table, error] of [["bigquery_billing_evidence", "conflict"], ["cost_settlements", "immutable"],
      ["evidence_receipts", "immutable"]]) {
      await expect(sqlite("run", `INSERT OR REPLACE INTO ${table} SELECT * FROM ${table}`)).rejects.toThrow(error);
    }
    expect(await ledger()).toMatchObject({ spent_units: 12, receipts: 3, events: 3, settlements: 1 });
  });

  it("does not backfill or adopt a settlement recorded before migration 0009", async () => {
    dbFile = "legacy.db";
    await sqlite("setup-v8");
    await prepareClaim();
    await terminal();
    await legacyReceipt();
    await sqlite("run", `INSERT INTO cost_settlements(tenant_id,intent_id,receipt_id,actual_units,actor)
      VALUES('t','i','legacy',12,'owner')`);
    await sqlite("apply-billing-evidence");
    await expect(reconcile(null)).rejects.toThrow("Unverified job settlement");
    await expect(reconcile(charge())).rejects.toThrow("billing evidence conflict");
    expect(await ledger()).toEqual({ spent_units: 12, reserved_units: 0, overrun_units: 0,
      bills: 0, settlements: 1, receipts: 2, events: 2 });
  });
});
