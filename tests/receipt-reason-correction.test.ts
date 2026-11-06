import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { reconcileBigQueryBill } from "../lib/bigquery-billing";
import { prepareIntentJob } from "../lib/bigquery-job-storage";
import { persistControlObject } from "../lib/control-storage";
import { appendReceiptReasonCorrection as append, readReceiptReasonCorrection as read } from "../lib/receipt-reason-correction";
import { exportSettledEvidence } from "../lib/settled-evidence-export";
import { jobDatabase, jobSqlite } from "./fixtures/job-sqlite";

let dir: string, file: string, baseline: string, receipt: string;
const owner = { db: jobDatabase(() => file), tenantId:"t", principalId:"owner" };
const first = { expectedRevision:0, correctedReason:"Charge covers the original query only.", evidenceRef:"ticket:42" };
const sql = (q: string, args: (string|number)[] = []) => jobSqlite(file,"run",q,args);
const counts = () => jobSqlite(file,"readonly-first",`SELECT reserved_units,spent_units,overrun_units,
  (SELECT count(*) FROM cost_settlements) settlements,(SELECT count(*) FROM evidence_receipts) receipts,
  (SELECT count(*) FROM receipt_reason_corrections) corrections,
  (SELECT count(*) FROM control_object_events WHERE object_kind='receipt_reason_correction') audits FROM control_budgets`);

describe("local owner receipt reason corrections", () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(),"odap-corrections-"));
    file = baseline = join(dir,"settled-v29.db");
    await jobSqlite(file,"setup-v29");
    await prepareIntentJob(owner,"i",{BIGQUERY_PROJECT_ID:"demo-project",BIGQUERY_LOCATION:"US"});
    await sql("INSERT INTO dispatch_claims(tenant_id,intent_id,claimed_by,maximum_bytes_billed) VALUES('t','i','owner',128)");
    await sql("INSERT INTO bigquery_terminal_observations(tenant_id,intent_id,outcome,has_bytes,observed_by) VALUES('t','i','failed',0,'owner')");
    const bill = await reconcileBigQueryBill(owner,"i",async key => ({...key,reference:"fixture:bill",amount:12,unit:"micro-USD",status:"final"}));
    if (bill.state !== "settled") throw new Error("Fixture not settled");
    receipt = bill.receipt.id;
  },30000);
  beforeEach(async () => {
    file = join(dir,"copy.db");
    await copyFile(baseline,file);
    await jobSqlite(file,"apply-receipt-corrections");
  });
  afterAll(async () => { if (dir) await rm(dir,{recursive:true,force:true}); });

  it("appends reason revisions with original bytes, outcome, cost and export digest unchanged", async () => {
    const source = await exportSettledEvidence(owner,"i"), before = await counts();
    expect(source).not.toBeNull();
    expect(before).toMatchObject({spent_units:12,settlements:1,corrections:0,audits:0});
    expect(await read(owner,receipt)).toBeNull();
    const [a,retry] = await Promise.all([append(owner,receipt,first),append(owner,receipt,first)]);
    expect(a).toEqual(retry);
    expect(a).toMatchObject({receiptId:receipt,tenantId:"t",revision:1,actor:"owner",correctedReason:first.correctedReason});
    const second = await append(owner,receipt,{...first,expectedRevision:1,correctedReason:"Only job execution is included."});
    expect(await read(owner,receipt)).toEqual(second);
    expect(await read(owner,receipt,1)).toEqual(a);
    expect(await append(owner,receipt,first)).toEqual(a);
    expect(await counts()).toEqual({...before,corrections:2,audits:2});
    expect(await exportSettledEvidence(owner,"i")).toEqual(source);
    expect(await jobSqlite(file,"readonly-first",`SELECT actor,recorded_at FROM control_object_events
      WHERE tenant_id='t' AND object_kind='receipt_reason_correction' AND object_id=json_array(?,1)`,[receipt]))
      .toEqual({actor:a.actor,recorded_at:a.recordedAt});
  },15000);

  it("serializes competing corrections and rejects stale, skipped and replacement revisions", async () => {
    const outcomes = await Promise.allSettled([first,{...first,correctedReason:"Different explanation."}].map(i=>append(owner,receipt,i)));
    expect(outcomes.filter(r=>r.status==="fulfilled")).toHaveLength(1);
    expect(outcomes.find(r=>r.status==="rejected")?.reason.message).toContain("revision conflict");
    const initial = await read(owner,receipt);
    await expect(append(owner,receipt,{...first,expectedRevision:2})).rejects.toThrow("revision conflict");
    for (const statement of ["UPDATE receipt_reason_corrections SET evidence_ref='changed'",
      "DELETE FROM receipt_reason_corrections",
      `INSERT OR REPLACE INTO receipt_reason_corrections(tenant_id,receipt_id,revision,corrected_reason,evidence_ref,actor)
       SELECT tenant_id,receipt_id,revision,'changed',evidence_ref,actor FROM receipt_reason_corrections`])
      await expect(sql(statement)).rejects.toThrow(/immutable receipt correction|revision conflict/);
    expect(await read(owner,receipt)).toEqual(initial);
    expect(await counts()).toMatchObject({corrections:1,audits:1});
  });

  it("denies nonowners, cross-tenant lookup and replay after owner revocation", async () => {
    await sql("INSERT INTO control_tenants VALUES('peer','Peer')");
    await sql("INSERT INTO control_memberships VALUES('peer','owner','owner',1),('t','review','reviewer',1)");
    await append(owner,receipt,first);
    await sql("UPDATE control_memberships SET active=0 WHERE tenant_id='t' AND principal_id='owner'");
    for (const who of [owner,{...owner,tenantId:"peer"},{...owner,principalId:"user"},{...owner,principalId:"review"}]) {
      await expect(read(who,receipt)).rejects.toThrow(/unavailable/i);
      await expect(append(who,receipt,first)).rejects.toThrow(/unavailable/i);
    }
    expect(await counts()).toMatchObject({corrections:1,audits:1});
  },15000);

  it("rechecks ownership at readback; a retry after access is restored cannot double append", async () => {
    await sql(`CREATE TRIGGER lose_owner AFTER INSERT ON receipt_reason_corrections BEGIN
      UPDATE control_memberships SET active=0 WHERE tenant_id=NEW.tenant_id AND principal_id=NEW.actor; END`);
    await expect(append(owner,receipt,first)).rejects.toThrow(/unavailable/i);
    expect(await counts()).toMatchObject({corrections:1,audits:1});
    await sql("UPDATE control_memberships SET active=1 WHERE tenant_id='t' AND principal_id='owner'");
    expect((await append(owner,receipt,first)).revision).toBe(1);
    expect(await counts()).toMatchObject({corrections:1,audits:1});
  });

  it("keeps independent revisions for identically named receipts in two tenants", async () => {
    await sql("INSERT INTO control_tenants VALUES('peer','Peer')");
    await sql("INSERT INTO control_memberships VALUES('peer','other-owner','owner',1)");
    const peer = {...owner,tenantId:"peer",principalId:"other-owner"}, id = "shared-denial";
    for (const who of [owner,peer]) await persistControlObject(who,"receipt",{tenantId:who.tenantId,id,schemaVersion:"0.1",
      intentId:"attempt",semanticReleaseId:null,contractId:null,outcome:"denied",reason:"Missing release",recordedAt:"2026-01-01T00:00:00.000Z"});
    const a = await append(owner,id,first);
    expect(await read(peer,id)).toBeNull();
    const b = await append(peer,id,{...first,correctedReason:"No release was selected."});
    expect(b).toMatchObject({revision:1,tenantId:"peer",actor:"other-owner"});
    expect(await read(owner,id)).toEqual(a);
    await expect(read({...owner,tenantId:"peer"},id)).rejects.toThrow(/unavailable/i);
  });

  it("rolls back a correction on audit failure and refuses an unaudited original receipt", async () => {
    await sql(`CREATE TRIGGER fail_correction BEFORE INSERT ON control_object_events WHEN NEW.object_kind='receipt_reason_correction'
      BEGIN SELECT RAISE(ABORT,'fixture audit unavailable'); END`);
    await expect(append(owner,receipt,first)).rejects.toThrow("fixture audit unavailable");
    expect(await counts()).toMatchObject({corrections:0,audits:0});
    await sql("DROP TRIGGER fail_correction");
    // Simulate historical damage only on this test copy.
    await sql("DROP TRIGGER control_event_no_delete");
    await sql("DELETE FROM control_object_events WHERE tenant_id='t' AND object_kind='receipt' AND object_id=?",[receipt]);
    await expect(append(owner,receipt,first)).rejects.toThrow(/unavailable/i);
    expect(await counts()).toMatchObject({corrections:0,audits:0,spent_units:12});
  });

  it("does not accept financial, identity, outcome or unsupported input fields", async () => {
    for (const change of [{amount:0},{outcome:"succeeded"},{actor:"owner"},{expectedRevision:-1},{expectedRevision:0.5},
      {correctedReason:" "},{correctedReason:"x".repeat(513)},{evidenceRef:"https://untrusted.test"},{evidenceRef:""}])
      await expect(append(owner,receipt,{...first,...change})).rejects.toThrow("Invalid receipt correction");
    expect(await counts()).toMatchObject({corrections:0,audits:0,spent_units:12});
  });

  it("rejects duplicate audit events and withholds a chain missing an earlier correction event", async () => {
    await append(owner,receipt,first);
    await append(owner,receipt,{...first,expectedRevision:1});
    await expect(sql(`INSERT INTO control_object_events(tenant_id,object_kind,object_id,actor,recorded_at)
      SELECT tenant_id,object_kind,object_id,actor,recorded_at FROM control_object_events
      WHERE object_kind='receipt_reason_correction' AND object_id=json_array(?,1)`,[receipt])).rejects.toThrow("unmatched correction event");
    await sql("DROP TRIGGER control_event_no_delete");
    await sql("DELETE FROM control_object_events WHERE object_kind='receipt_reason_correction' AND object_id=json_array(?,1)",[receipt]);
    await expect(read(owner,receipt)).rejects.toThrow(/unavailable/i);
    await expect(append(owner,receipt,{...first,expectedRevision:2})).rejects.toThrow(/unavailable/i);
    expect(await counts()).toMatchObject({corrections:2,audits:1,spent_units:12});
  });
});
