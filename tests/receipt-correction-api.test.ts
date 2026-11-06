import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_COOKIE, signAuthPayload } from "../lib/auth";
import { persistControlObject } from "../lib/control-storage";
import { recordMissingReleaseDenial } from "../lib/preapproval-denial";
import { inspectEvidenceReceipt, inspectReceiptExplanation, inspectReceiptRevision, submitReceiptCorrection } from "../lib/receipt-inspection";
import worker from "../worker";
import { jobDatabase, jobSqlite } from "./fixtures/job-sqlite";

let dir: string, baseline: string, file: string;
const origin = "https://gateway.test";
const db = jobDatabase(() => file);
const env = { DB: db, AUTH_COOKIE_SECRET: "synthetic-correction-test-only",
  ASSETS: { fetch: async () => { throw new Error("Unexpected assets request"); } } };
const first = { expectedRevision: 0, correctedReason: "Release was absent.", evidenceRef: "ticket:42" };
const path = "/api/control/t/receipt-corrections/denial";
const sql = (q: string) => jobSqlite(file, "run", q);
const counts = () => jobSqlite(file, "readonly-first", `SELECT count(*) AS corrections,
  (SELECT count(*) FROM control_object_events WHERE object_kind='receipt_reason_correction') AS audits
  FROM receipt_reason_corrections`);

async function call(method: string, { subject = "owner", url = path, body = JSON.stringify(first), headers = {} }:
  { subject?: string; url?: string; body?: string; headers?: Record<string,string> } = {}) {
  const cookie = subject ? SESSION_COOKIE + "=" + await signAuthPayload({ provider: "google", providerId: subject,
    name: "Fixture", email: "fixture@example.test", expiresAt: Date.now() + 60000 }, env.AUTH_COOKIE_SECRET) : "";
  return worker.fetch(new Request(origin + url, { method, headers: { Cookie: cookie, Origin: origin,
    "Content-Type": "application/json", "X-Role": "owner", "X-Principal-Id": "google:owner", "X-Tenant-Id": "t", ...headers },
    ...(method === "POST" && { body }) }), env, { waitUntil: () => undefined });
}
async function error(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(await response.json()).toEqual({ ok: false, code });
}
async function success(response: Response) {
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  const body = await response.json();
  expect(body.ok).toBe(true);
  return body.correction;
}

describe("owner HTTP receipt reason corrections", () => {
  beforeAll(async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network disabled"));
    dir = await mkdtemp(join(tmpdir(), "odap-correction-api-"));
    file = baseline = join(dir, "baseline.db");
    await jobSqlite(file, "setup");
    await sql("INSERT INTO control_tenants VALUES ('peer','Peer')");
    await sql(`INSERT INTO control_memberships VALUES ('t','google:owner','owner',1),('t','google:reader','reader',1),
      ('t','google:review','reviewer',1),('t','google:revoked','owner',0),('peer','google:peer','owner',1)`);
    for (const [tenantId, principalId] of [["t","google:owner"],["peer","google:peer"]])
      await persistControlObject({ db, tenantId, principalId }, "receipt", { tenantId, id: "denial", schemaVersion: "0.1",
        intentId: "attempt", semanticReleaseId: null, contractId: null, outcome: "denied", reason: "Missing release",
        recordedAt: "2026-01-01T00:00:00.000Z" });
  }, 20000);
  beforeEach(async () => { file = join(dir,"copy.db"); await copyFile(baseline,file); });
  afterAll(async () => {
    try { expect(globalThis.fetch).not.toHaveBeenCalled(); }
    finally { vi.restoreAllMocks(); if (dir) await rm(dir,{ recursive:true,force:true }); }
  });

  it("distinguishes no annotation, unavailable target, exact revision and conflicting command", async () => {
    expect(await success(await call("GET"))).toBeNull();
    await error(await call("GET",{ url:path+"?revision=1" }),404,"receipt_correction_unavailable");
    for (const method of ["GET","POST"])
      await error(await call(method,{ url:path+"-absent" }),404,"receipt_correction_unavailable");
    const a = await success(await call("POST"));
    expect(a).toMatchObject({ revision:1, tenantId:"t", receiptId:"denial", actor:"google:owner", evidenceRef:first.evidenceRef });
    const b = await success(await call("POST",{ body:JSON.stringify({ ...first,expectedRevision:1,correctedReason:"Updated reason" }) }));
    expect(b.revision).toBe(2);
    expect(await success(await call("GET"))).toEqual(b);
    expect(await success(await call("GET",{ url:path+"?revision=1" }))).toEqual(a);
    expect(await success(await call("POST"))).toEqual(a);
    for (const change of [{ correctedReason:"Replacement" },{ expectedRevision:3 }])
      await error(await call("POST",{ body:JSON.stringify({ ...first,...change }) }),409,"receipt_correction_conflict");
    expect(await success(await call("GET",{ subject:"peer",url:path.replace("/t/","/peer/") }))).toBeNull();
    expect(await counts()).toEqual({ corrections:2,audits:2 });
  },15000);

  it("compares the issued reason with only the latest audited revision in the authorized tenant", async () => {
    const url = path.replace("receipt-corrections","receipt-explanations");
    const signal = new AbortController().signal;
    const view = (subject: string, tenant = "t") => inspectReceiptExplanation(tenant,"denial",signal,
      async address => call("GET",{ subject,url:String(address) }));
    const base = { tenantId:"t",id:"denial",issuedReason:"Missing release",latest:null };
    expect(await view("owner")).toEqual({ state:"ready",snapshot:base });
    await success(await call("POST"));
    await success(await call("POST",{ body:JSON.stringify({ ...first,expectedRevision:1,correctedReason:"Updated" }) }));
    const res = await call("GET",{ url });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({ ok:true,object:{ ...base,latest:{ revision:2,correctedReason:"Updated" } } });
    expect(await view("owner")).toEqual({ state:"ready",snapshot:{ ...base,latest:{ revision:2,correctedReason:"Updated" } } });
    expect(await view("peer","peer")).toEqual({ state:"ready",snapshot:{ ...base,tenantId:"peer" } });
    for (const subject of ["reader","review","revoked","peer"]) expect(await view(subject)).toEqual({ state:"denied" });
    expect(await view("")).toEqual({ state:"unauthenticated" });
    await error(await call("GET",{ url:url+"?view=raw" }),400,"invalid_receipt_view");
    expect((await call("POST",{ url })).status).toBe(405);
    await sql("DROP TRIGGER control_event_no_delete");
    await sql("DELETE FROM control_object_events WHERE object_kind='receipt_reason_correction' AND object_id=json_array('denial',1)");
    expect(await view("owner")).toEqual({ state:"not_found" });
    await sql("DROP VIEW receipt_correction_targets");
    expect(await view("owner")).toEqual({ state:"unavailable" });
  },15000);

  it("does not overwrite a competing owner or replay an append after a lost acknowledgment", async () => {
    const signal = new AbortController().signal;
    const read = async () => {
      const result = await inspectReceiptExplanation("t","denial",signal,async url => call("GET",{ url:String(url) }));
      if (result.state !== "ready") throw new Error("Expected owner view");
      return result.snapshot;
    };
    await sql("INSERT INTO control_memberships VALUES ('t','google:second','owner',1)");
    const initial = await read();
    expect(initial.latest).toBeNull();
    await success(await call("POST",{subject:"second"}));
    const post: typeof fetch = (url,init) => call("POST",{ url:String(url),body:String(init?.body) });
    expect(await submitReceiptCorrection(initial,"Owner note","ticket:43",signal,post)).toEqual({state:"conflict"});
    expect(await counts()).toEqual({corrections:1,audits:1});
    const reviewed = await read();
    const lost = vi.fn<typeof fetch>(async (url,init) => {
      const response = await post(url,init);
      expect(response.status).toBe(200);
      throw new TypeError("Simulated lost response");
    });
    expect(await submitReceiptCorrection(reviewed,"Owner note","ticket:43",signal,lost)).toEqual({state:"uncertain",attemptedRevision:2});
    expect(lost).toHaveBeenCalledTimes(1);
    await success(await call("POST",{subject:"second",body:JSON.stringify({
      expectedRevision:2,correctedReason:"Owner note",evidenceRef:"ticket:other"})}));
    const history = (rev: number, subject = "owner") => inspectReceiptRevision("t","denial",rev,signal,
      async url => call("GET",{ subject,url:String(url) }));
    expect(await history(2)).toMatchObject({state:"historical",record:{revision:2,actor:"google:owner",correctedReason:"Owner note",evidenceRef:"ticket:43"}});
    expect(await history(3)).toMatchObject({state:"historical",record:{revision:3,actor:"google:second",correctedReason:"Owner note",evidenceRef:"ticket:other"}});
    expect(await history(4)).toEqual({state:"revision_unavailable"});
    expect(await history(2,"peer")).toEqual({state:"denied"});
    expect(await history(2,"")).toEqual({state:"unauthenticated"});
    const recovered = await read();
    expect(recovered).toEqual({...initial,latest:{revision:3,correctedReason:"Owner note"}});
    expect(await counts()).toEqual({corrections:3,audits:3});
    expect(await submitReceiptCorrection(recovered,"Clarified note","ticket:44",signal,post)).toEqual({state:"recorded",revision:4});
  },15000);

  it("accepts a full-length issued denial ID, but not encoded separators or malformed escapes", async () => {
    const denied = await recordMissingReleaseDenial({ db,tenantId:"t",principalId:"google:owner" },
      "a:.".padEnd(128,"x"), "agent", "absent", { metricId:"revenue",target:"orders",parameters:{} });
    const prefix = path.slice(0,path.lastIndexOf("/") + 1);
    const url = prefix + encodeURIComponent(denied.id);
    expect((await success(await call("POST",{ url }))).receiptId).toBe(denied.id);
    expect((await success(await call("GET",{ url }))).revision).toBe(1);
    const get: typeof fetch = async address => call("GET",{ url:String(address) });
    const signal = new AbortController().signal;
    expect(await inspectEvidenceReceipt("t",denied.id,signal,get)).toMatchObject({ state:"ready",snapshot:{ id:denied.id } });
    expect(await inspectReceiptExplanation("t",denied.id,signal,get)).toMatchObject({ state:"ready",snapshot:{ issuedReason:denied.reason } });
    await error(await call("GET",{ url:url.replace("receipt-corrections","receipt") }),400,"invalid_control_path");
    for (const suffix of ["a%2Fb","a%252Fb","a%","a".repeat(129)])
      await error(await call("GET",{ url:prefix+"denied_preapproval_"+suffix }),400,"invalid_control_path");
  });

  it.each(["GET","POST"])("uses only active session membership for %s despite owner headers", async method => {
    await error(await call(method,{ subject:"" }),401,"unauthenticated");
    for (const subject of ["reader","review"])
      await error(await call(method,{ subject }),403,"receipt_correction_denied");
    for (const subject of ["peer","revoked"])
      await error(await call(method,{ subject }),403,"tenant_access_denied");
    expect(await counts()).toEqual({ corrections:0,audits:0 });
  });

  it("rejects malformed views, identity and monetary fields, unsafe writes and unsupported methods", async () => {
    for (const query of ["?revision=0","?revision=01","?revision=9007199254740992","?revision=1&revision=2","?tenantId=peer"])
      await error(await call("GET",{ url:path+query }),400,"invalid_receipt_correction_view");
    await error(await call("POST",{ url:path+"?revision=1" }),400,"invalid_receipt_correction_view");
    await error(await call("GET",{ url:path+"!" }),400,"invalid_control_path");
    for (const body of ["{", ...[{ actor:"google:owner" },{ tenantId:"peer" },{ actualMicroUsd:0 },
      { outcome:"succeeded" },{ evidenceRef:"" }].map(change => JSON.stringify({ ...first,...change }))])
      await error(await call("POST",{ body }),400,"invalid_receipt_correction");
    await error(await call("POST",{ headers:{ Origin:"https://elsewhere.test" } }),403,"same_origin_required");
    await error(await call("POST",{ headers:{ "Content-Type":"text/plain" } }),415,"json_required");
    await error(await call("POST",{ body:"x".repeat(8193) }),413,"receipt_correction_too_large");
    const unsupported = await call("PUT");
    expect(unsupported.status).toBe(405);
    expect(unsupported.headers.get("Allow")).toBe("GET, POST");
    expect(await counts()).toEqual({ corrections:0,audits:0 });
  },10000);

  it("does not expose a database error as either a revision conflict or successful write", async () => {
    await sql(`CREATE TRIGGER audit_fault BEFORE INSERT ON control_object_events WHEN NEW.object_kind='receipt_reason_correction'
      BEGIN SELECT RAISE(ABORT,'private: receipt correction revision conflict'); END`);
    await error(await call("POST"),503,"control_storage_unavailable");
    expect(await counts()).toEqual({ corrections:0,audits:0 });
    await sql("DROP VIEW receipt_correction_targets");
    await error(await call("GET"),503,"control_storage_unavailable");
  });
});
