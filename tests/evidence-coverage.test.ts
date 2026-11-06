import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { reconcileBigQueryBill } from "../lib/bigquery-billing";
import { prepareIntentJob } from "../lib/bigquery-job-storage";
import type { ControlAccess } from "../lib/control-storage";
import type { D1Database, D1Value } from "../lib/d1";
import { readEvidenceCoverage } from "../lib/evidence-coverage";
import { exportSettledEvidence } from "../lib/settled-evidence-export";
import { recordMissingReleaseDenial } from "../lib/preapproval-denial";
import { jobSqlite } from "./fixtures/job-sqlite";

let dir: string, file: string;
const sql = (mode: string, query = "", params: D1Value[] = []) => jobSqlite(file, mode, query, params);
function owner(readOnly = true, tenantId = "t"): ControlAccess {
  const db = { prepare: (query: string) => ({ bind: (...params: D1Value[]) => ({
    first: () => sql(readOnly ? "readonly-first" : "first", query, params),
    run: () => sql(readOnly ? "readonly-first" : "run", query, params)
  }) }) } as D1Database;
  return { db, tenantId, principalId: "owner" };
}
async function admit(id: string) {
  await sql("run", `INSERT INTO approval_contracts(tenant_id,id,release_id,payload,created_by)
    SELECT tenant_id,?,release_id,json_set(payload,'$.id',?,'$.reservationId',?),created_by
    FROM approval_contracts WHERE tenant_id='t' AND id='c'`, ["c-" + id, "c-" + id, "s-" + id]);
  await sql("run", `INSERT INTO execution_intents
    SELECT tenant_id,?,?,budget_id,?,principal_id,action_digest,1,created_at
    FROM execution_intents WHERE tenant_id='t' AND id='i'`, [id, "c-" + id, "s-" + id]);
}
const prepare = (id: string) => prepareIntentJob(owner(false), id,
  { BIGQUERY_PROJECT_ID: "demo-project", BIGQUERY_LOCATION: "US" });
async function observe(id: string) {
  await sql("run", `INSERT INTO dispatch_claims(tenant_id,intent_id,claimed_by,maximum_bytes_billed)
    VALUES('t',?,'owner',128)`, [id]);
  await sql("run", `INSERT INTO bigquery_terminal_observations(tenant_id,intent_id,outcome,billed_bytes,has_bytes,observed_by)
    VALUES('t',?,'cancelled',NULL,0,'owner'),('t',?,'cancelled',0,1,'owner')`, [id, id]);
}
const settle = (id: string) => reconcileBigQueryBill(owner(false), id, async key => ({
  ...key, status: "final", unit: "micro-USD", amount: 0, reference: "fixture:" + id
}));
const mixed = { admitted: 5, missingReleaseRefusals: 1, recordedAttempts: 6, pendingOutcome: 1,
  pendingBilling: 1, attributedSettlements: 1, unattributedSettlements: 1, missingEvidence: 1 };
const empty = { admitted: 0, missingReleaseRefusals: 0, recordedAttempts: 0, pendingOutcome: 0,
  pendingBilling: 0, attributedSettlements: 0, unattributedSettlements: 0, missingEvidence: 0 };

describe("owner-scoped evidence inventory", () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "odap-inventory-"));
    file = join(dir, "seed.db");
    await sql("setup-v8");
    await sql("run", `INSERT INTO evidence_receipts(tenant_id,id,contract_id,release_id,payload,created_by)
      VALUES('t','legacy','c','r',?,'owner')`, [JSON.stringify({ id: "legacy", schemaVersion: "0.1", tenantId: "t",
      contractId: "c", semanticReleaseId: "r", intentId: "i", outcome: "succeeded",
      reason: "synthetic legacy settlement", recordedAt: "2026-01-01T00:00:00.000Z" })]);
    await sql("run", "INSERT INTO cost_settlements(tenant_id,intent_id,receipt_id,actual_units,actor) VALUES('t','i','legacy',7,'owner')");
    await sql("apply-billing-evidence");
    await sql("apply-preapproval-denials");
    for (const id of ["gap", "prepared", "waiting", "billed"]) await admit(id);
    for (const id of ["prepared", "waiting", "billed"]) await prepare(id);
    for (const id of ["waiting", "billed"]) await observe(id);
    await settle("billed");
    await settle("billed");
    await sql("run", "INSERT INTO control_tenants VALUES('other','Other'),('empty','Empty')");
    await sql("run", "INSERT INTO control_memberships VALUES('other','owner','owner',1),('empty','owner','owner',1)");
    for (const tenant of ["t", "t", "other"]) {
      await recordMissingReleaseDenial(owner(false, tenant), "deny-1", "agent", "missing",
        { target: "orders", metricId: "revenue", parameters: {} });
    }
    await copyFile(file, join(dir, "historical-v10.db"));
    await sql("upgrade-v10-snapshot");
  }, 45_000);
  beforeEach(async () => {
    file = join(dir, "case.db");
    await copyFile(join(dir, "seed.db"), file);
  });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  it("counts each recorded attempt once in a mixed snapshot with multiple terminal samples and replays", async () => {
    const access = owner();
    const prepareStatement = vi.spyOn(access.db, "prepare");
    const report = await readEvidenceCoverage(access);
    expect(report).toEqual(mixed);
    expect(prepareStatement).toHaveBeenCalledTimes(1);
    expect(await readEvidenceCoverage(owner(true, "other"))).toEqual({ ...empty, missingReleaseRefusals: 1, recordedAttempts: 1 });
  });

  it("returns zeroes only for an active owner, not for unauthorized or unknown scopes", async () => {
    expect(await readEvidenceCoverage(owner(true, "empty"))).toEqual(empty);
    expect(await readEvidenceCoverage({ ...owner(), principalId: "user" })).toBeNull();
    expect(await readEvidenceCoverage(owner(true, "absent"))).toBeNull();
    await sql("run", "UPDATE control_memberships SET active=0 WHERE tenant_id='t' AND principal_id='owner'");
    expect(await readEvidenceCoverage(owner())).toBeNull();
    expect(await readEvidenceCoverage(owner(true, "other"))).toEqual({ ...empty, missingReleaseRefusals: 1, recordedAttempts: 1 });
  });

  it("does not borrow a receipt for a matching intent and contract ID in another tenant", async () => {
    await sql("run", "INSERT INTO control_memberships VALUES('other','user','reader',1)");
    await sql("run", "INSERT INTO control_budgets(tenant_id,id,limit_units) VALUES('other','b',10)");
    await sql("run", `INSERT INTO semantic_releases(tenant_id,id,payload,created_by)
      SELECT 'other',id,json_set(payload,'$.tenantId','other'),'owner' FROM semantic_releases WHERE tenant_id='t' AND id='r'`);
    await sql("run", `INSERT INTO approval_contracts(tenant_id,id,release_id,payload,created_by)
      SELECT 'other',id,release_id,json_set(payload,'$.tenantId','other'),'owner' FROM approval_contracts
      WHERE tenant_id='t' AND id='c-gap'`);
    await sql("run", `INSERT INTO execution_intents
      SELECT 'other',id,contract_id,budget_id,reservation_id,principal_id,action_digest,reserved_units,created_at
      FROM execution_intents WHERE tenant_id='t' AND id='gap'`);
    await prepareIntentJob(owner(false, "other"), "gap", { BIGQUERY_PROJECT_ID: "demo-project", BIGQUERY_LOCATION: "US" });
    // The other tenant's same-ID intent must stay pending even if ours is corrupt.
    await prepare("gap");
    await observe("gap");
    await sql("run","DROP TRIGGER terminal_observation_no_update");
    await sql("run","UPDATE bigquery_terminal_observations SET outcome='failed' WHERE tenant_id='t' AND intent_id='gap' AND has_bytes=1");
    expect(await readEvidenceCoverage(owner())).toEqual(mixed);
    expect(await readEvidenceCoverage(owner(true, "other"))).toEqual({ ...empty, admitted: 1,
      pendingOutcome: 1, missingReleaseRefusals: 1, recordedAttempts: 2 });
  });

  it("moves a single admission through the evidence states without increasing either denominator", async () => {
    await prepare("gap");
    expect(await readEvidenceCoverage(owner())).toEqual({ ...mixed, missingEvidence: 0, pendingOutcome: 2 });
    await observe("gap");
    expect(await readEvidenceCoverage(owner())).toEqual({ ...mixed, missingEvidence: 0, pendingBilling: 2 });
    await settle("gap");
    expect(await readEvidenceCoverage(owner())).toEqual({ ...mixed, missingEvidence: 0, attributedSettlements: 2 });
  }, 15_000);

  it("counts only conflicting non-delegated intents as gaps, irrespective of settlement", async () => {
    expect(await exportSettledEvidence(owner(),"billed")).not.toBeNull();
    await sql("run","DROP TRIGGER terminal_observation_no_update");
    await sql("run",`UPDATE bigquery_terminal_observations SET outcome='succeeded'
      WHERE tenant_id='t' AND intent_id IN ('waiting','billed') AND has_bytes=1`);
    expect(await readEvidenceCoverage(owner())).toEqual({...mixed,pendingBilling:0,attributedSettlements:0,missingEvidence:3});
    expect(await exportSettledEvidence(owner(),"billed")).toBeNull();
  });

  it.each([
    ["prepared","pending","wrong actor","pendingOutcome"],
    ["waiting","pending","wrong timestamp","pendingBilling"],
    ["i","succeeded","wrong kind","unattributedSettlements"],
    ["billed","pending","missing","attributedSettlements"],
    ["billed","cancelled","other tenant","attributedSettlements"],
    ["billed","cancelled","duplicate","attributedSettlements"]
  ] as const)("requires a receipt creation event: %s / %s / %s", async (intent,outcome,damage,bucket) => {
    // Damage predates the write guards; the upgrade must not rewrite history.
    await copyFile(join(dir,"historical-v10.db"),file);
    const { id } = await sql("readonly-first",`SELECT id FROM evidence_receipts WHERE tenant_id='t'
      AND json_extract(payload,'$.intentId')=? AND json_extract(payload,'$.outcome')=?`,[intent,outcome]);
    const match = "WHERE tenant_id='t' AND object_kind='receipt' AND object_id=?";
    const mutations = {
      "missing": "DELETE FROM control_object_events",
      "other tenant": "UPDATE control_object_events SET tenant_id='other'",
      "wrong kind": "UPDATE control_object_events SET object_kind='contract'",
      "wrong actor": "UPDATE control_object_events SET actor='other'",
      "wrong timestamp": "UPDATE control_object_events SET recorded_at='2000-01-01T00:00:00.000Z'",
      "duplicate": `INSERT INTO control_object_events(tenant_id,object_kind,object_id,actor,recorded_at)
        SELECT tenant_id,object_kind,object_id,actor,recorded_at FROM control_object_events`
    };
    await sql("run", mutations[damage]+" "+match, [id]);
    await sql("upgrade-v10-snapshot");
    expect(await readEvidenceCoverage(owner())).toEqual({...mixed,[bucket]:0,missingEvidence:2});
    expect(Boolean(await exportSettledEvidence(owner(),"billed"))).toBe(intent!=="billed");
  });

  it.each([
    ["update", "UPDATE control_object_events SET actor='changed' WHERE sequence=?"],
    ["delete", "DELETE FROM control_object_events WHERE sequence=?"],
    ["replace under another kind", `INSERT OR REPLACE INTO control_object_events(sequence,tenant_id,object_kind,object_id,actor)
      VALUES(?,'other','release','replacement','changed')`],
    ["upsert", `INSERT INTO control_object_events(sequence,tenant_id,object_kind,object_id,actor)
      VALUES(?,'t','contract','replacement','changed') ON CONFLICT(sequence) DO UPDATE SET actor=excluded.actor`],
    ["duplicate", `INSERT INTO control_object_events(tenant_id,object_kind,object_id,actor,recorded_at)
      SELECT tenant_id,object_kind,object_id,actor,recorded_at FROM control_object_events WHERE sequence=?`]
  ])("protects existing audit history from %s", async (_,statement) => {
    const original = await sql("readonly-first",`SELECT * FROM control_object_events WHERE tenant_id='t' AND object_kind='receipt'
      AND object_id=(SELECT receipt_id FROM cost_settlements WHERE tenant_id='t' AND intent_id='billed')`);
    const bundle = await exportSettledEvidence(owner(),"billed");
    expect(bundle).not.toBeNull();
    await expect(sql("run",statement,[original.sequence])).rejects.toThrow(/immutable control event|duplicate receipt event/);
    expect(await sql("readonly-first","SELECT * FROM control_object_events WHERE sequence=?",[original.sequence])).toEqual(original);
    expect(await exportSettledEvidence(owner(),"billed")).toEqual(bundle);
    expect(await readEvidenceCoverage(owner())).toEqual(mixed);
  });

  it("preserves old gaps and unusual sequence numbers without preventing a new legitimate receipt", async () => {
    await copyFile(join(dir,"historical-v10.db"),file);
    await sql("run", "DELETE FROM control_object_events WHERE tenant_id='t' AND object_kind='receipt' AND object_id='legacy'");
    await sql("run", `INSERT INTO control_object_events(sequence,tenant_id,object_kind,object_id,actor)
      VALUES(-1,'t','legacy','negative','historical'),(10000,'t','legacy','last','historical')`);
    await sql("upgrade-v10-snapshot");
    for (const seq of [-1,0,9999]) {
      await expect(sql("run",`REPLACE INTO control_object_events(sequence,tenant_id,object_kind,object_id,actor)
        VALUES(?,'other','release','different','changed')`,[seq])).rejects.toThrow("invalid control event sequence");
    }
    await expect(sql("run",`INSERT INTO control_object_events(tenant_id,object_kind,object_id,actor,recorded_at)
      SELECT tenant_id,'receipt',id,created_by,created_at FROM evidence_receipts WHERE tenant_id='t' AND id='legacy'`))
      .rejects.toThrow("unmatched receipt event");
    await expect(sql("run",`INSERT INTO control_object_events(tenant_id,object_kind,object_id,actor)
      VALUES('t','receipt','nonexistent','owner')`)).rejects.toThrow("unmatched receipt event");
    expect(await sql("readonly-first","SELECT object_id,actor FROM control_object_events WHERE sequence=-1"))
      .toEqual({object_id:"negative",actor:"historical"});
    expect(await readEvidenceCoverage(owner())).toEqual({...mixed,unattributedSettlements:0,missingEvidence:2});
    const receipt = await recordMissingReleaseDenial(owner(false),"fresh","agent","missing",{target:"orders",metricId:"revenue",parameters:{}});
    expect(await sql("readonly-first",`SELECT COUNT(*) AS n,MIN(sequence)>10000 AS appended FROM control_object_events
      WHERE tenant_id='t' AND object_kind='receipt' AND object_id=?`,[receipt.id])).toEqual({n:1,appended:1});
  });
  it("keeps a broken monetary link visible instead of reclassifying it as a legacy settlement", async () => {
    // Deliberately corrupt only this disposable fixture copy; the report still uses mode=ro.
    await sql("run", "DROP TRIGGER bigquery_bill_no_update");
    await sql("run", "UPDATE bigquery_billing_evidence SET actual_micro_usd=1 WHERE tenant_id='t' AND intent_id='billed'");
    expect(await readEvidenceCoverage(owner())).toEqual({ ...mixed, missingEvidence: 2, attributedSettlements: 0 });
  });
});
