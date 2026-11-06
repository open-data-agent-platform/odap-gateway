import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readDelegatedBilling, reconcileDelegatedBill } from "../lib/delegated-billing";
import { observeDelegatedClaim } from "../lib/delegated-job-recovery";
import { canonicalControlJson } from "../lib/control-objects";
import { readEvidenceCoverage } from "../lib/evidence-coverage";
import { readOwnAdmission } from "../lib/delegated-admission";
import { delegatedSettledEvidenceProfile, settledEvidenceProfile, verifySettledEvidence } from "../lib/settled-evidence";
import { exportSettledEvidence } from "../lib/settled-evidence-export";
import { delegationFixture } from "./fixtures/delegation";
import { corruptTerminalEnrichment } from "./fixtures/conflicting-terminal";
import { jobDatabase, jobSqlite } from "./fixtures/job-sqlite";
import { readOwnIntentReceipt } from "../lib/requester-intent-receipt";
import { SESSION_COOKIE, signAuthPayload } from "../lib/auth";
import worker from "../worker";

let dir: string, file: string, baseline: string, prepared: string, enrolled: CryptoKeyPair;
let intentId: string, delegationId: string, contractId: string, receiptId: string, tag: string, cap: string;
let ref: { projectId: string; location: string; jobId: string };
const { db,first,sql,keys,seedAmbiguousDelegation,revoke,env,origin } = delegationFixture(()=>file,()=>enrolled);
const owner = { db,tenantId:"t",principalId:"google:operator" }, audience = "test-gateway";
const charge = (amount = 12) => ({ tenantId:"t",jobReference:{ ...ref },reference:"fixture:job-total",status:"final",unit:"micro-USD",amount });
const bill = (value: unknown) => reconcileDelegatedBill(owner,audience,intentId,async()=>value);
const stored = () => readDelegatedBilling(owner,audience,intentId);
const requesterReceipt = () => readOwnIntentReceipt({ db:jobDatabase(()=>file,"readonly"),tenantId:"t",principalId:"google:reader" },audience,intentId);
const upgrade = () => jobSqlite(file,"apply-delegated-billing");
const terminal = (reason?: string) => observeDelegatedClaim(owner,audience,intentId,async()=>Response.json({
  jobReference:ref,configuration:{ jobType:"QUERY",labels:{ odap_action:tag },query:{ maximumBytesBilled:cap } },
  status:{ state:"DONE",...(reason && {errorResult:{reason}}) }
})); // No byte count: monetary attribution must still come from the bill.
const ledger = () => first(`SELECT reserved_units,spent_units,overrun_units,(SELECT count(*) FROM bigquery_billing_evidence) bills,
  (SELECT count(*) FROM cost_settlements) settlements,(SELECT count(*) FROM evidence_receipts) receipts,
  (SELECT count(*) FROM control_object_events WHERE object_kind='receipt') events FROM control_budgets WHERE tenant_id='t' AND id='b'`);

describe("claim-attributed delegated billing", { timeout:25000 }, () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(),"odap-delegated-bill-"));
    file = baseline = join(dir,"claimed-v25.db"); prepared = join(dir,"prepared-v24.db");
    enrolled = await keys();
    ({ intentId,delegationId,contractId,receiptId,ref,tag,cap } = await seedAmbiguousDelegation(()=>copyFile(file,prepared)));
    await jobSqlite(file,"apply-delegated-observations");
  },30000);
  beforeEach(async () => {
    file = join(dir,crypto.randomUUID()+".db");
    await copyFile(baseline,file);
    await upgrade();
  });
  afterAll(async () => { if (dir) await rm(dir,{ recursive:true,force:true }); });

  it.each(["pending","settled without pending event","settled without final event"])(
    "requires a receipt creation event on the delegated chain: %s", async phase => {
      const settled = phase !== "pending";
      if (settled) { await terminal(); await bill(charge()); }
      const before = await ledger(), coverage = await readEvidenceCoverage(owner);
      expect((await requesterReceipt())?.receipt?.outcome).toBe(settled ? "succeeded" : "pending");
      expect(Boolean(await exportSettledEvidence(owner,intentId,audience))).toBe(settled);
      const id = phase === "settled without final event" ? "final_"+ref.jobId : receiptId;
      await sql("DELETE FROM control_object_events WHERE tenant_id='t' AND object_kind='receipt' AND object_id=?",[id]);
      await expect(requesterReceipt()).rejects.toThrow("Unverified receipt chain");
      expect(await exportSettledEvidence(owner,intentId,audience)).toBeNull();
      expect(await readEvidenceCoverage(owner)).toEqual({...coverage,
        [settled ? "attributedSettlements" : "pendingOutcome"]:0,missingEvidence:2});
      expect(await ledger()).toEqual({...before,events:before.events-1});
    });

  it.each(["before","during-final","during-null"])("refuses a terminal conflict: %s", async phase => {
    await terminal();
    const before = await ledger(), corrupt = () => corruptTerminalEnrichment(sql,intentId);
    if (phase === "before") await corrupt();
    const load = vi.fn(async () => {
      if (phase !== "before") await corrupt();
      return phase === "during-null" ? null : charge();
    });
    await expect.soft(reconcileDelegatedBill(owner,audience,intentId,load)).rejects.toThrow(/conflicting terminal outcomes/i);
    expect.soft(load).toHaveBeenCalledTimes(Number(phase !== "before"));
    expect(await ledger()).toEqual(before);
  });

  it("does not request charges before terminal evidence or spend on missing, estimated or provisional charges", async () => {
    const before = await ledger(), load = vi.fn(async()=>null);
    expect(await reconcileDelegatedBill(owner,audience,intentId,load)).toEqual({ state:"pending-terminal" });
    expect(load).not.toHaveBeenCalled();
    await terminal();
    for (const value of [null,...["pending","estimated","provisional"].map(status=>({ ...charge(0),status }))])
      expect(await bill(value)).toEqual({ state:"pending-bill" });
    expect(await ledger()).toEqual(before);
  });
  it("blocks direct delegated billing on upgrading an inconsistent v26 copy without rewriting it", async () => {
    await terminal();
    await corruptTerminalEnrichment(sql,intentId);
    const before = await ledger();
    await jobSqlite(file,"apply-consistent-billing-outcome");
    await expect(sql(`INSERT INTO bigquery_billing_evidence
      (tenant_id,intent_id,receipt_id,evidence_ref,actual_micro_usd,actor,delegation_audience,claim_body_digest,attributed_project,attributed_location)
      SELECT tenant_id,intent_id,'final_'||job_id,'fixture:direct',12,operator_id,audience,compiled_body_digest,project_id,location
      FROM delegated_billing_jobs WHERE tenant_id='t' AND intent_id=? AND audience=? AND operator_id=?`,
      [intentId,audience,owner.principalId])).rejects.toThrow("conflicting terminal outcomes");
    expect(await jobSqlite(file,"readonly-first","SELECT COUNT(DISTINCT outcome) n FROM bigquery_terminal_observations WHERE tenant_id='t' AND intent_id=?",[intentId]))
      .toEqual({n:2});
    expect(await ledger()).toEqual(before);
  });
  it.each([["succeeded","",0],["cancelled","stopped",12],["failed","invalidQuery",125]] as const)(
    "settles %s (reason '%s', %i micro-USD) only once across independent connections", async (outcome,reason,amount) => {
      const before = await ledger();
      expect((await revoke(delegationId)).status).toBe(200);
      await terminal(reason);
      expect(await requesterReceipt()).toMatchObject({ intentId,contractId,delegationId,receipt:{ id:receiptId,outcome:"pending" } });
      const load = vi.fn(async()=>charge(amount));
      const [a,b] = await Promise.all([reconcileDelegatedBill(owner,audience,intentId,load),reconcileDelegatedBill(owner,audience,intentId,load)]);
      expect(a).toEqual(b);
      expect(load.mock.calls).toEqual(Array.from({length:2},()=>[{ tenantId:"t",jobReference:ref }]));
      expect(a).toMatchObject({ state:"settled",actualMicroUsd:amount,reference:"fixture:job-total",receipt:{
        id:"final_"+ref.jobId,tenantId:"t",intentId,contractId,semanticReleaseId:"released",outcome } });
      expect(await stored()).toEqual(a);
      expect((await requesterReceipt())?.receipt).toEqual({ id:"final_"+ref.jobId,tenantId:"t",outcome,
        recordedAt:expect.any(String),hasContract:true,hasSemanticRelease:true });
      expect(await bill(null)).toEqual(a);
      expect(await bill({ ...charge(),status:"provisional" })).toEqual(a);
      await expect(bill(charge(amount+1))).rejects.toThrow("conflict");
      await expect(bill({ ...charge(amount),reference:"different" })).rejects.toThrow("conflict");
      expect(await first(`SELECT count(*) n FROM evidence_receipts WHERE json_extract(payload,'$.outcome')='pending'`)).toEqual({ n:1 });
      expect(await ledger()).toEqual({ reserved_units:20,spent_units:Math.min(80,amount),overrun_units:Math.max(0,amount-80),
        bills:1,settlements:1,receipts:before.receipts+1,events:before.events+1 });
      expect(await readOwnAdmission({ ...owner, principalId:"google:reader" },audience,contractId))
        .toMatchObject({ intentId, contractId, originalMicroUsd:80 });
    });
  it("serializes competing final bills without combining, overwriting or double-debiting them", async () => {
    await terminal();
    const before = await ledger();
    const inputs = [charge(13),{ ...charge(27),reference:"fixture:other-final" }];
    const attempts = await Promise.allSettled(inputs.map(bill));
    const winner = attempts.findIndex(r=>r.status==="fulfilled");
    expect(winner).not.toBe(-1);
    const other = attempts[1-winner];
    expect(other.status === "rejected" && String(other.reason)).toMatch(/conflict/);
    const { reference,amount } = inputs[winner];
    expect(await stored()).toMatchObject({ state:"settled",reference,actualMicroUsd:amount });
    expect(await ledger()).toEqual({ ...before,reserved_units:20,spent_units:amount,bills:1,settlements:1,
      receipts:before.receipts+1,events:before.events+1 });
  });
  it("refuses foreign charges, malformed totals, incorrect job attribution and a forged claim pin", async () => {
    await terminal();
    const before = await ledger();
    for (const change of [{tenantId:"other"},{unit:"USD"},{amount:-1},{amount:0.5},{amount:Number.MAX_SAFE_INTEGER+1},
      {amount:null},{reference:""},{status:"unknown"},{status:"pending",tenantId:"other"},
      ...["projectId","location","jobId"].map(k=>({jobReference:{ ...ref,[k]:"other" }}))])
      await expect(bill({ ...charge(),...change })).rejects.toThrow("Invalid final");
    const q = `INSERT INTO bigquery_billing_evidence(tenant_id,intent_id,receipt_id,evidence_ref,actual_micro_usd,actor,
      delegation_audience,claim_body_digest,attributed_project,attributed_location) VALUES('t',? ,?,'ref',12,'google:operator',?,?,?,?)`;
    const { digest } = await first("SELECT compiled_body_digest digest FROM dispatch_claims");
    for (const pins of [["other",digest,ref.projectId,ref.location],[audience,"wrong",ref.projectId,ref.location],
      [audience,digest,"other",ref.location],[audience,digest,ref.projectId,"EU"]])
      await expect(sql(q,[intentId,"final_"+ref.jobId,...pins])).rejects.toThrow("attributed delegated bill required");
    expect(await ledger()).toEqual(before);
  });
  it.each(["settle","still pending"])("requires live owner and audience at readback: %s", async mode => {
    await terminal();
    const before = await ledger(), load = vi.fn(async()=>{
      await sql("UPDATE control_memberships SET active=0 WHERE tenant_id='t' AND principal_id='google:operator'");
      return mode==="settle" ? charge() : null;
    });
    await sql("INSERT INTO control_tenants VALUES('peer','Peer')");
    await sql("INSERT INTO control_memberships VALUES('peer','google:operator','owner',1)");
    for (const [who,scope] of [[{ ...owner,tenantId:"peer" },audience],[{ ...owner,principalId:"google:reader" },audience],[owner,"wrong"]] as const)
      await expect(reconcileDelegatedBill(who,scope,intentId,load)).rejects.toThrow("claim unavailable");
    expect(load).not.toHaveBeenCalled();
    await expect(reconcileDelegatedBill(owner,audience,intentId,load)).rejects.toThrow("scope unavailable");
    expect(await ledger()).toEqual(before);
  });
  it("rolls the bill, receipt, audit event and counter updates back together", async () => {
    await terminal();
    const before = await ledger();
    await sql("CREATE TRIGGER fail_money BEFORE UPDATE OF spent_units ON control_budgets BEGIN SELECT RAISE(ABORT,'ledger fault'); END");
    await expect(bill(charge())).rejects.toThrow("ledger fault");
    expect(await ledger()).toEqual(before);
    await sql("DROP TRIGGER fail_money");
    expect(await bill(charge())).toMatchObject({ state:"settled",actualMicroUsd:12 });
  });
  it("reads a committed settlement locally after the write acknowledgement is lost", async () => {
    await terminal();
    const load = vi.fn(async()=>charge());
    const hooked: typeof db = { prepare(q) {
      const p = db.prepare(q);
      if (!q.startsWith("INSERT INTO bigquery_billing_evidence")) return p;
      return { ...p,bind(...args) {
        const stmt = p.bind(...args);
        return { ...stmt,async run() { await stmt.run(); throw new Error("fixture: lost acknowledgement"); } };
      } };
    } };
    await expect(reconcileDelegatedBill({ ...owner,db:hooked },audience,intentId,load)).rejects.toThrow("lost acknowledgement");
    const saved = await stored();
    expect(saved).toMatchObject({ state:"settled",actualMicroUsd:12 });
    expect(load).toHaveBeenCalledTimes(1);
    expect(await bill(charge())).toEqual(saved);
    expect(await ledger()).toMatchObject({ bills:1,settlements:1,spent_units:12 });
  });
  it("retains but does not certify a previously settled bill without delegated provenance", async () => {
    file = join(dir,crypto.randomUUID()+".db");
    await copyFile(baseline,file);
    await terminal();
    await sql(`INSERT INTO bigquery_billing_evidence(tenant_id,intent_id,receipt_id,evidence_ref,actual_micro_usd,actor)
      VALUES('t',?,?,'old',12,'google:operator')`,[intentId,"final_"+ref.jobId]);
    const before = await ledger();
    await upgrade();
    const load = vi.fn(async()=>charge());
    await expect(reconcileDelegatedBill(owner,audience,intentId,load)).rejects.toThrow("Unverified delegated settlement");
    expect(load).not.toHaveBeenCalled();
    expect(await first("SELECT claim_body_digest,delegation_audience FROM bigquery_billing_evidence")).toEqual({ claim_body_digest:null,delegation_audience:null });
    await expect(requesterReceipt()).rejects.toThrow("Unverified receipt chain");
    expect(await ledger()).toEqual(before);
    expect(await exportSettledEvidence(owner,intentId)).toBeNull();
    expect(await readEvidenceCoverage(owner)).toMatchObject({ admitted:2,attributedSettlements:0,missingEvidence:2 });
  });
  it("exports the original pins after revocation and counts the job once for its owner", async () => {
    const reader = { ...owner, principalId:"google:owner" };
    expect(await exportSettledEvidence(reader,intentId)).toBeNull();
    expect(await readEvidenceCoverage(reader)).toMatchObject({ admitted:2,pendingOutcome:1,attributedSettlements:0 });
    await terminal("stopped");
    expect(await readEvidenceCoverage(reader)).toMatchObject({ pendingBilling:1,attributedSettlements:0 });
    await bill(charge());
    expect((await revoke(delegationId)).status).toBe(200);
    await sql("UPDATE control_memberships SET active=0 WHERE tenant_id='t' AND principal_id='google:operator'");
    expect(await exportSettledEvidence(reader,intentId,"wrong")).toBeNull();
    const bundle = await exportSettledEvidence(reader,intentId,audience);
    if (!bundle) throw new Error("Expected a delegated bundle");
    const { digest } = await first("SELECT compiled_body_digest AS digest FROM dispatch_claims");
    const scope = { tenantId:"t",intentId,audience };
    expect(JSON.parse(bundle.json)).toMatchObject({ profile:delegatedSettledEvidenceProfile, delegation:{
      admissionAudience:audience,claimAudience:audience,observedAudience:audience,billedAudience:audience,
      claimDigest:digest,observedDigest:digest,billedDigest:digest,billedProject:ref.projectId,billedLocation:ref.location
    } });
    expect(await verifySettledEvidence(bundle.json,scope,bundle.digest)).toMatchObject({ issuerAuthenticated:false,
      delegation:{ audience,claimDigest:digest }, actualMicroUsd:12,outcome:"cancelled" });
    expect(await readEvidenceCoverage(reader)).toMatchObject({ admitted:2,attributedSettlements:1,missingEvidence:1 });
    expect(await exportSettledEvidence(owner,intentId)).toBeNull();
    expect(await readEvidenceCoverage(owner)).toBeNull();
    await sql("INSERT INTO control_tenants VALUES('peer','Peer')");
    await sql("INSERT INTO control_memberships VALUES('peer','google:reader','owner',1)");
    const peer = { ...reader,tenantId:"peer",principalId:"google:reader" };
    expect(await exportSettledEvidence(peer,intentId)).toBeNull();
    expect(await readEvidenceCoverage(peer)).toMatchObject({ admitted:0,attributedSettlements:0 });
    expect(await exportSettledEvidence({ ...peer,tenantId:"t" },intentId)).toBeNull();
    for (const key of Object.keys(JSON.parse(bundle.json).delegation)) {
      const changed = JSON.parse(bundle.json);
      changed.delegation[key] = "other";
      await expect(verifySettledEvidence(canonicalControlJson(changed),scope)).rejects.toThrow("attribution mismatch");
    }
    const downgraded = JSON.parse(bundle.json);
    delete downgraded.delegation;
    downgraded.profile = settledEvidenceProfile;
    await expect(verifySettledEvidence(canonicalControlJson(downgraded),scope)).rejects.toThrow("scope mismatch");
    await expect(verifySettledEvidence(bundle.json,{ ...scope,audience:"other" })).rejects.toThrow("scope mismatch");
  });
  it.each([["delegation_audience","foreign"],["claim_body_digest","wrong"],["attributed_project","peer-project"],
    ["attributed_location","EU"]])("excludes a mixed-scope bill (%s) from export and coverage", async (column,value) => {
    await terminal(); await bill(charge());
    // Corrupt only the disposable copy to simulate a mixed-source import.
    await sql("DROP TRIGGER bigquery_bill_no_update");
    await sql(`UPDATE bigquery_billing_evidence SET ${column}=? WHERE tenant_id='t' AND intent_id=?`,[value,intentId]);
    await expect(requesterReceipt()).rejects.toThrow("Unverified receipt chain");
    expect(await exportSettledEvidence(owner,intentId)).toBeNull();
    expect(await readEvidenceCoverage(owner)).toMatchObject({ admitted:2,attributedSettlements:0,missingEvidence:2 });
  });
  it.each(["unbilled","settled"])("quarantines contradictory outcomes without discarding valid byte enrichment (%s)", async phase => {
    await terminal("stopped");
    const settled = phase === "settled";
    if (settled) await bill(charge());
    const bundle = await exportSettledEvidence(owner,intentId,audience);
    expect(Boolean(bundle)).toBe(settled);
    const enrichment = `INSERT INTO bigquery_terminal_observations
      (tenant_id,intent_id,outcome,billed_bytes,has_bytes,observed_by,delegation_audience,claim_body_digest)
      SELECT tenant_id,intent_id,?,0,1,observed_by,delegation_audience,claim_body_digest
      FROM bigquery_terminal_observations WHERE tenant_id='t' AND intent_id=? AND has_bytes=0`;
    await expect(sql(enrichment,["failed",intentId])).rejects.toThrow("conflicting terminal observation");
    await sql(enrichment,["cancelled",intentId]);
    expect(await exportSettledEvidence(owner,intentId,audience)).toEqual(bundle);
    expect((await requesterReceipt())?.receipt?.outcome).toBe(settled ? "cancelled" : "pending");
    const coverage = await readEvidenceCoverage(owner);
    expect(coverage).toMatchObject({pendingBilling:Number(!settled),attributedSettlements:Number(settled),missingEvidence:1});
    const before = await ledger();
    // Simulate an inconsistent restore without changing the original witness or final receipt.
    await sql("DROP TRIGGER terminal_observation_no_update");
    await sql("UPDATE bigquery_terminal_observations SET outcome='failed' WHERE tenant_id='t' AND intent_id=? AND has_bytes=1",[intentId]);
    expect.soft(await readEvidenceCoverage(owner)).toEqual({...coverage,pendingBilling:0,attributedSettlements:0,missingEvidence:2});
    expect.soft(await exportSettledEvidence(owner,intentId,audience)).toBeNull();
    await expect.soft(requesterReceipt()).rejects.toThrow("Unverified receipt chain");
    await expect(stored()).rejects.toThrow(/conflicting terminal outcomes/i);
    const token = await signAuthPayload({ provider:"google",providerId:"reader",name:"Fixture",
      email:"fixture@example.test",expiresAt:Date.now()+60000 },env.AUTH_COOKIE_SECRET);
    const response = await worker.fetch(new Request(origin+"/api/control/t/intent-receipt/"+intentId,
      {headers:{Cookie:SESSION_COOKIE+"="+token}}),{...env,DB:jobDatabase(()=>file,"readonly")},{waitUntil:()=>undefined});
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ok:false,code:"control_storage_unavailable"});
    expect(await ledger()).toEqual(before);
  });
  it("withholds the whole chain when only the later terminal sample belongs to another audience", async () => {
    await terminal(); await bill(charge());
    const bundle = await exportSettledEvidence(owner,intentId,audience);
    expect(bundle).not.toBeNull();
    await sql(`INSERT INTO bigquery_terminal_observations
      (tenant_id,intent_id,outcome,billed_bytes,has_bytes,observed_by,delegation_audience,claim_body_digest)
      SELECT tenant_id,intent_id,outcome,7,1,observed_by,delegation_audience,claim_body_digest
      FROM bigquery_terminal_observations WHERE has_bytes=0`);
    expect(await exportSettledEvidence(owner,intentId,audience)).toEqual(bundle);
    await sql("DROP TRIGGER terminal_observation_no_update");
    await sql("UPDATE bigquery_terminal_observations SET delegation_audience='foreign' WHERE has_bytes=1");
    await expect(requesterReceipt()).rejects.toThrow("Unverified receipt chain");
    expect(await exportSettledEvidence(owner,intentId)).toBeNull();
    expect(await readEvidenceCoverage(owner)).toMatchObject({ admitted:2,attributedSettlements:0,missingEvidence:2 });
  });
  it("blocks generic settlement even before the delegated job has a dispatch claim", async () => {
    file = join(dir,crypto.randomUUID()+".db");
    await copyFile(prepared,file);
    await jobSqlite(file,"apply-delegated-observations"); await upgrade();
    await sql(`INSERT INTO evidence_receipts(tenant_id,id,release_id,contract_id,payload,created_by)
      SELECT tenant_id,'standin',release_id,contract_id,json_set(payload,'$.id','standin','$.outcome','failed'),'google:operator'
      FROM evidence_receipts WHERE id=?`,[receiptId]);
    expect((await requesterReceipt())?.receipt).toMatchObject({ id:receiptId,outcome:"pending" });
    const before = await ledger();
    await expect(sql("INSERT INTO cost_settlements(tenant_id,intent_id,receipt_id,actual_units,actor) VALUES('t',?,'standin',0,'google:operator')",
      [intentId])).rejects.toThrow("verified delegated billing evidence required");
    expect(await ledger()).toEqual(before);
  });
});
