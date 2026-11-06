import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SESSION_COOKIE, signAuthPayload } from "../lib/auth";
import { inspectEvidenceReceipt, inspectOwnIntentReceipt, inspectReceiptExplanation, inspectReceiptRevision, submitReceiptCorrection } from "../lib/receipt-inspection";
import { intentJobId } from "../lib/bigquery-job-identity";
import worker from "../worker";
import { jobDatabase, jobSqlite } from "./fixtures/job-sqlite";

const signal = new AbortController().signal;
const recordedAt = "2026-01-01T00:00:00.000Z";
const summary = { id:"shared", tenantId:"t", outcome:"succeeded", recordedAt, hasContract:true, hasSemanticRelease:true };
const reason = "SELECT private_fixture FROM private_table WHERE actor = 'synthetic@example.test'";

describe("receipt inspection boundary", () => {
  it("submits only reviewed scope, revision, reason and reference, and confirms only matching evidence", async () => {
    const inspected = {tenantId:"t",id:"denied_preapproval_t:1",issuedReason:"Issued",latest:null};
    const correction = {tenantId:"t",receiptId:inspected.id,revision:1,correctedReason:"Owner reason",evidenceRef:"ticket:42",actor:"test-owner",recordedAt};
    const send = (post: typeof fetch) => submitReceiptCorrection(inspected,"Owner reason","ticket:42",signal,post);
    const post = vi.fn(async () => Response.json({ok:true,correction}));
    expect(await send(post)).toEqual({state:"recorded",revision:1});
    expect(post).toHaveBeenCalledWith("/api/control/t/receipt-corrections/denied_preapproval_t%3A1",{
      method:"POST",mode:"same-origin",credentials:"same-origin",cache:"no-store",redirect:"error",signal,
      headers:{"Content-Type":"application/json"},body:JSON.stringify({expectedRevision:0,correctedReason:"Owner reason",evidenceRef:"ticket:42"})});
    for (const drift of [{tenantId:"peer"},{receiptId:"other"},{revision:2},{correctedReason:"other"},{evidenceRef:"extra"},{actor:""},{recordedAt:"now"}])
      expect(await send(async () => Response.json({ok:true,correction:{...correction,...drift}}))).toEqual({state:"uncertain",attemptedRevision:1});
    for (const [reason,ref] of [["","ref"],["ok","https://private.test"]])
      expect(await submitReceiptCorrection(inspected,reason,ref,signal,post)).toEqual({state:"invalid_correction"});
    expect(post).toHaveBeenCalledTimes(1);
  });
  it("only accepts a strictly scoped, exact revision and never falls back to the latest correction", async () => {
    const id = "denied_preapproval_case:7";
    const row = {tenantId:"t",receiptId:id,revision:2,correctedReason:"Prior",actor:"test-owner",evidenceRef:"ticket:7",recordedAt};
    const get = vi.fn(async () => Response.json({ok:true,correction:row}));
    for (const rev of [0,-1,1.5,Number.MAX_SAFE_INTEGER+1])
      expect(await inspectReceiptRevision("t",id,rev,signal,get)).toEqual({state:"revision_unavailable"});
    expect(get).not.toHaveBeenCalled();
    expect(await inspectReceiptRevision("t",id,2,signal,get)).toMatchObject({state:"historical",record:{revision:2,actor:"test-owner"}});
    expect(get).toHaveBeenCalledWith("/api/control/t/receipt-corrections/denied_preapproval_case%3A7?revision=2",{
      method:"GET",mode:"same-origin",credentials:"same-origin",cache:"no-store",redirect:"error",signal});
    for (const change of [{tenantId:"peer"},{receiptId:"other"},{revision:3},{actor:"  "},{recordedAt:"now"},
      {correctedReason:""},{evidenceRef:"https://bad.test"},{rawPayload:"unexpected"}])
      expect(await inspectReceiptRevision("t",id,2,signal,async () => Response.json({ok:true,correction:{...row,...change}})))
        .toEqual({state:"unavailable"});
  });

  it("does not display explanations from another scope or malformed, overbroad or incomplete snapshots", async () => {
    const base = { tenantId:"t",id:"shared",issuedReason:"Original",latest:null };
    for (const change of [{ tenantId:"peer" },{ id:"another" },{ latest:undefined },{ issuedReason:"" },{ actor:"extra" },
      { latest:{ revision:0,correctedReason:"Changed" } },{ latest:{ revision:2,correctedReason:"" } },
      { latest:{ revision:2,correctedReason:"Changed",evidenceRef:"extra" } }]) {
      expect(await inspectReceiptExplanation("t","shared",signal,
        async () => Response.json({ ok:true,object:{ ...base,...change } }))).toEqual({ state:"unavailable" });
    }
  });
  it("rejects a substituted intent, receipt, outcome, or private payload", async () => {
    const s = { tenantId:"t",intentId:"i",contractId:"c",delegationId:"d",actionDigest:"sha256:"+"a".repeat(64) };
    const receipt = { ...summary,id:"final_"+await intentJobId("t","i") };
    const inspect = (object: unknown) => inspectOwnIntentReceipt(s,signal,async()=>Response.json({ok:true,object}));
    expect(await inspect({ ...s,receipt })).toEqual({state:"ready",snapshot:{receipt}});
    for (const field of Object.keys(s))
      expect(await inspect({ ...s,[field]:"other",receipt })).toEqual({state:"unavailable"});
    for (const change of [{id:"final_"+await intentJobId("t","other")},{tenantId:"other"},{outcome:"pending"},{outcome:"denied"},{reason}])
      expect(await inspect({ ...s,receipt:{...receipt,...change} })).toEqual({state:"unavailable"});
  });
  it("requests only a scoped no-store summary; an invalid ID never initiates a read", async () => {
    const get = vi.fn(async () => Response.json({ok:true,summary}));
    expect(await inspectEvidenceReceipt("../t","shared",signal,get)).toEqual({state:"invalid"});
    expect(await inspectEvidenceReceipt("t","shared?view=raw",signal,get)).toEqual({state:"invalid"});
    expect(get).not.toHaveBeenCalled();
    expect(await inspectEvidenceReceipt("t","shared",signal,get)).toEqual({state:"ready",snapshot:summary});
    expect(get).toHaveBeenCalledWith("/api/control/t/receipt/shared?view=summary",{
      method:"GET",credentials:"same-origin",cache:"no-store",redirect:"error",signal
    });
  });
  it("rejects legacy objects, wrong scope, unknown outcomes, bad timestamps and unexpected data", async () => {
    for (const body of [{ok:true,object:{...summary,reason}}, ...[
      {tenantId:"peer"}, {id:"other"}, {outcome:"paid"}, {outcome:"constructor"}, {recordedAt:"now"},
      {hasContract:false}, {hasSemanticRelease:null}, {actualMicroUsd:0}, {reason}
    ].map(change => ({ok:true,summary:{...summary,...change}}))]) {
      expect(await inspectEvidenceReceipt("t","shared",signal,async () => Response.json(body))).toEqual({state:"unavailable"});
    }
  });
});

describe("receipt summary via the Worker with read-only SQLite", () => {
  let dir: string, file: string;
  const env = {DB:jobDatabase(() => file,"readonly"),AUTH_COOKIE_SECRET:"receipt-test-only-session-key",
    ASSETS:{fetch:async () => {throw new Error("Unexpected asset read");}}};
  async function read(tenant: string, id: string, subject: string, query = "?view=summary", db = env.DB) {
    const cookie = subject ? SESSION_COOKIE + "=" + await signAuthPayload({provider:"google",providerId:subject,
      name:"Demo",email:"fixture@example.test",expiresAt:Date.now()+60000},env.AUTH_COOKIE_SECRET) : "";
    return worker.fetch(new Request("https://gateway.test/api/control/"+tenant+"/receipt/"+id+query,
      {headers:{Cookie:cookie,"X-Principal-Id":"google:owner"}}),{ ...env, DB:db },{waitUntil:() => undefined});
  }
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(),"odap-receipt-inspection-"));
    file = join(dir,"fixture.db");
    await jobSqlite(file,"setup");
    await jobSqlite(file,"run","INSERT INTO control_tenants VALUES('peer','Peer')");
    await jobSqlite(file,"run",`INSERT INTO control_memberships VALUES ('t','google:owner','owner',1),('t','google:reviewer','reviewer',1),
      ('t','google:reader','reader',1),('t','google:inactive','owner',0),('peer','google:owner','reader',1)`);
    for (const [tenantId,id,outcome] of [
      ["t","shared","succeeded"], ["peer","shared","denied"], ["t","p","pending"], ["t","f","failed"], ["t","x","cancelled"]
    ]) {
      const contractId = outcome === "denied" ? null : "c", semanticReleaseId = outcome === "denied" ? null : "r";
      const payload = {schemaVersion:"0.1",tenantId,id,intentId:"private_fixture",outcome,reason,recordedAt,contractId,semanticReleaseId};
      await jobSqlite(file,"run","INSERT INTO evidence_receipts(tenant_id,id,release_id,contract_id,payload,created_by) VALUES(?,?,?,?,?,?)",
        [tenantId,id,semanticReleaseId,contractId,JSON.stringify(payload),"synthetic@example.test"]);
    }
  });
  afterAll(async () => { if (dir) await rm(dir,{recursive:true,force:true}); });
  it.each([
    ["t","shared","owner","succeeded"], ["peer","shared","owner","denied"], ["t","p","reader","pending"],
    ["t","f","reviewer","failed"], ["t","x","reader","cancelled"]
  ])("returns only recorded facts for %s/%s as %s (%s)", async (tenantId,id,subject,outcome) => {
    const res = await read(tenantId,id,subject);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({ok:true,summary:{
      tenantId,id,outcome,recordedAt,hasContract:outcome !== "denied",hasSemanticRelease:outcome !== "denied"
    }});
  });
  it.each(["reader","reviewer","owner"])("preserves the unqualified same-tenant object for an active %s", async role => {
    const res = await read("t","shared",role,"");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({ok:true,object:{tenantId:"t",id:"shared",outcome:"succeeded",
      schemaVersion:"0.1",recordedAt,intentId:"private_fixture",contractId:"c",semanticReleaseId:"r",reason}});
  });
  it("never widens an unrecognized or ambiguous query to the unredacted receipt", async () => {
    const prepare = vi.fn((sql: string) => env.DB.prepare(sql));
    for (const q of ["?View=summary","?views=summary","?view[]=summary","?view=summary&format=json",
      "?view=", "?view=raw", "?view=summary&view=summary","?&&"]) {
      const res = await read("t","shared","reader",q,{ prepare });
      expect(res.status).toBe(400);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      expect(await res.json()).toEqual({ok:false,code:"invalid_receipt_view"});
    }
    expect(prepare.mock.calls.some(([sql]) => sql.includes("evidence_receipts"))).toBe(false);
    expect((await read("t","shared","","?View=summary")).status).toBe(401);
    expect((await read("t","shared","inactive","?View=summary")).status).toBe(403);
  });
  it.each(["","?view=summary"])("enforces authentication and active tenant membership before disclosing existence (%s)", async query => {
    for (const [tenant,id,subject,status,code] of [
      ["t","shared","",401,"unauthenticated"], ["t","shared","inactive",403,"tenant_access_denied"],
      ["peer","shared","reader",403,"tenant_access_denied"], ["peer","absent","reader",403,"tenant_access_denied"],
      ["t","absent","reader",404,"not_found"]
    ] as const) {
      const res = await read(tenant,id,subject,query);
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual({ok:false,code});
    }
  });
  it.each(["","?view=summary"])("checks membership again if revoked between authentication and receipt lookup (%s)", async query => {
    const subject = query ? "race-summary" : "race-full";
    await jobSqlite(file,"run","INSERT INTO control_memberships VALUES('t',?,'reader',1)",["google:"+subject]);
    let revoked = false;
    const db: typeof env.DB = { prepare(sql) {
      const p = env.DB.prepare(sql);
      if (!sql.includes("FROM evidence_receipts")) return p;
      return { ...p,bind(...args) {
        const statement = p.bind(...args);
        return { ...statement,async first<T>() {
          await jobSqlite(file,"run","UPDATE control_memberships SET active=0 WHERE tenant_id='t' AND principal_id=?",["google:"+subject]);
          revoked = true;
          return statement.first<T>();
        } };
      } };
    } };
    const res = await read("t","shared",subject,query,db);
    expect(revoked).toBe(true);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ok:false,code:"not_found"});
  });
});
