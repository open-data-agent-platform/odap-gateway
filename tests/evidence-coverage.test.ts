import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { reconcileBigQueryBill } from "../lib/bigquery-billing";
import { prepareIntentJob } from "../lib/bigquery-job-storage";
import type { ControlAccess } from "../lib/control-storage";
import type { D1Database, D1Value } from "../lib/d1";
import { readEvidenceCoverage } from "../lib/evidence-coverage";
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

  it("keeps a broken monetary link visible instead of reclassifying it as a legacy settlement", async () => {
    // Deliberately corrupt only this disposable fixture copy; the report still uses mode=ro.
    await sql("run", "DROP TRIGGER bigquery_bill_no_update");
    await sql("run", "UPDATE bigquery_billing_evidence SET actual_micro_usd=1 WHERE tenant_id='t' AND intent_id='billed'");
    expect(await readEvidenceCoverage(owner())).toEqual({ ...mixed, missingEvidence: 2, attributedSettlements: 0 });
  });
});
