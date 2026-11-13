import { execFile } from "node:child_process";
import { copyFile, link, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { requestJobCancellation } from "../lib/bigquery-cancellation";
import { prepareIntentJob } from "../lib/bigquery-job-storage";
import { exportCancellationEvidence } from "../lib/cancellation-evidence-export";
import { requestDelegatedCancellation } from "../lib/delegated-cancellation";
import { reconcileDelegatedBill } from "../lib/delegated-billing";
import { observeDelegatedClaim } from "../lib/delegated-job-recovery";
import { delegationFixture } from "./fixtures/delegation";
import { jobDatabase, jobSqlite } from "./fixtures/job-sqlite";

const exec = promisify(execFile);
const python = process.env.ODAP_TEST_PYTHON || (process.platform === "win32" ? "python" : "python3");
const audience = "test-gateway";
let dir: string, intentId: string;
let exported: Awaited<ReturnType<typeof exportCancellationEvidence>>;
const file = (name: string) => join(dir,name + ".sqlite");
const access = (name: string, readonly = false) => ({db:jobDatabase(() => file(name),readonly ? "readonly" : "readwrite"),
  tenantId:"t",principalId:"google:operator"});
const sql = (name: string, query: string, params: string[] = []) => jobSqlite(file(name),"run",query,params);
async function compare(restored: string, reference: string, code = 0, tenant = "t") {
  const result = await exec(python,["-B","scripts/check-restore-cancellations.py","--restored",file(restored),
    "--reference",file(reference),"--tenant",tenant]).then(r => ({...r,code:0}),
    (e: {code:number;stdout:string;stderr:string}) => e);
  expect(result.code).toBe(code);
  if (code === 2) {
    expect(result.stdout).toBe("");
    expect(result.stderr.replace(/\r\n/g,"\n")).toBe("No comparison: unusable standalone snapshots, tenant or cancellation bindings.\n");
    return null;
  }
  expect(result.stderr).toBe("");
  expect(result.stdout).not.toContain(intentId);
  expect(result.stdout).not.toMatch(/google:|SELECT |net_amount|sha256:|odap_/);
  return JSON.parse(result.stdout);
}
async function corrupted(name: string, queries: string[], source = "requested") {
  await copyFile(file(source),file(name));
  await exec(python,["-B","-c",`import json,sqlite3,sys
with sqlite3.connect(sys.argv[1]) as db:
    db.execute('PRAGMA ignore_check_constraints=ON')
    for query in json.loads(sys.argv[2]):
        db.execute(query)
`,file(name),JSON.stringify(queries)]);
}
const requestUpdate = "DROP TRIGGER cancellation_request_no_update";
const claimUpdate = "DROP TRIGGER dispatch_claim_no_update";
const bindingUpdate = "DROP TRIGGER bigquery_binding_no_update";

describe("offline cancellation request restore comparison", {timeout:25000}, () => {
  beforeAll(async () => {
    vi.spyOn(globalThis,"fetch").mockRejectedValue(new Error("No network in restore comparison"));
    dir = await mkdtemp(join(tmpdir(),"odap-cancellation-restore-"));
    const pair = await crypto.subtle.generateKey({name:"ECDSA",namedCurve:"P-256"},false,["sign","verify"]);
    const f = delegationFixture(() => file("live"),() => pair);
    const job = await f.seedAmbiguousDelegation(async () => undefined); intentId = job.intentId;
    await jobSqlite(file("live"),"apply-delegated-observations");
    await jobSqlite(file("live"),"apply-delegated-billing");
    await f.sql("INSERT INTO control_tenants VALUES('peer','Peer')");
    await f.sql("VACUUM INTO ?",[file("pre34")]);
    await copyFile(file("pre34"),file("legacy"));
    await sql("legacy","INSERT INTO bigquery_cancellation_requests(tenant_id,intent_id,job_id,requested_by) VALUES('t',?,?,'google:operator')",
      [intentId,job.ref.jobId]);
    await jobSqlite(file("legacy"),"apply-delegated-cancellation");
    await jobSqlite(file("live"),"apply-delegated-cancellation");
    await f.sql("VACUUM INTO ?",[file("unrequested")]);
    await requestDelegatedCancellation(access("live"),audience,intentId);
    await f.sql("VACUUM INTO ?",[file("requested")]);
    exported = await exportCancellationEvidence(access("requested",true),audience,intentId);
    expect(exported).not.toBeNull();
    expect((await f.revoke(job.delegationId)).status).toBe(200);
    await f.sql("UPDATE control_memberships SET active=0 WHERE tenant_id='t'");
    await f.sql("VACUUM INTO ?",[file("revoked")]);
    for(const outcome of ["succeeded","failed","cancelled"] as const) {
      await copyFile(file("requested"),file(outcome));
      await observeDelegatedClaim(access(outcome),audience,intentId,async () => Response.json({jobReference:job.ref,
        configuration:{jobType:"QUERY",labels:{odap_action:job.tag},query:{maximumBytesBilled:job.cap}},
        status:{state:"DONE",...(outcome!=="succeeded"&&{errorResult:{reason:outcome==="cancelled"?"stopped":"invalid"}})}}));
    }
    await copyFile(file("cancelled"),file("billed"));
    await reconcileDelegatedBill(access("billed"),audience,intentId,async key => ({...key,reference:"fixture:request-restore-bill",
      amount:12,status:"final",unit:"micro-USD"}));
    await jobSqlite(file("direct"),"setup");
    const owner = {...access("direct"),principalId:"owner"};
    await prepareIntentJob(owner,"i",{BIGQUERY_PROJECT_ID:"demo-project",BIGQUERY_LOCATION:"US"});
    await sql("direct","INSERT INTO dispatch_claims(tenant_id,intent_id,claimed_by,maximum_bytes_billed) VALUES('t','i','owner',128)");
    await requestJobCancellation(owner,"i");
  },90000);
  afterAll(async () => {
    expect(globalThis.fetch).not.toHaveBeenCalled(); vi.restoreAllMocks();
    if(dir) await rm(dir,{recursive:true,force:true});
  });

  it("preserves bytes, sidecar absence and exported provenance across a restored copy",async () => {
    await copyFile(file("requested"),file("restored"));
    const paths=[file("requested"),file("restored")],before=await Promise.all(paths.map(p=>readFile(p))),names=await readdir(dir);
    const report=await compare("restored","requested");
    expect(report).toMatchObject({requestComparison:"equal",referenceOnly:0,restoredOnly:0,changed:0,
      scope:"recorded-tenant-cancellation-requests-only",issuerAuthenticated:false,cancellationConfirmed:false,
      retryAuthorized:false,servingAuthorized:false,restored:{requests:1,attributedDelegatedRequests:1,
        unattributedDelegatedRequests:0,nonDelegatedRequests:0}});
    expect(report.restored).toEqual(report.reference);
    expect(await exportCancellationEvidence(access("restored",true),audience,intentId)).toEqual(exported);
    for(let i=0;i<paths.length;i++) expect((await readFile(paths[i])).equals(before[i])).toBe(true);
    expect(await readdir(dir)).toEqual(names);
  });
  it("never turns a missing request into permission to replay, even for two identical old copies",async () => {
    await copyFile(file("unrequested"),file("parked"));
    expect(await compare("unrequested","parked")).toMatchObject({requestComparison:"equal",restored:{requests:0},retryAuthorized:false});
    expect(await compare("unrequested","requested",1)).toMatchObject({referenceOnly:1,restoredOnly:0,changed:0,cancellationConfirmed:false});
    expect(await compare("requested","unrequested",1)).toMatchObject({referenceOnly:0,restoredOnly:1,changed:0,retryAuthorized:false});
  });
  it("keeps pre-upgrade delegated requests unattributed instead of manufacturing consent",async () => {
    await copyFile(file("legacy"),file("legacy-copy"));
    expect(await compare("legacy","legacy-copy")).toMatchObject({restored:{requests:1,unattributedDelegatedRequests:1,attributedDelegatedRequests:0}});
    expect(await compare("legacy","requested",1)).toMatchObject({changed:1,reference:{attributedDelegatedRequests:1}});
    expect(await exportCancellationEvidence(access("legacy",true),audience,intentId)).toBeNull();
  });
  it("retains historical requests after grant and current-owner withdrawal",async () => {
    expect(await compare("requested","revoked")).toMatchObject({requestComparison:"equal",restored:{requests:1},servingAuthorized:false});
    expect(await exportCancellationEvidence(access("revoked",true),audience,intentId)).toBeNull();
  });
  it.each(["succeeded","failed","cancelled","billed"])("does not infer cancellation or rewrite a request after %s",async outcome => {
    expect(await compare("requested",outcome)).toMatchObject({requestComparison:"equal",cancellationConfirmed:false,retryAuthorized:false});
    expect(await exportCancellationEvidence(access(outcome,true),audience,intentId)).toEqual(exported);
  });
  it("distinguishes a non-delegated request without adding delegated provenance",async () => {
    await copyFile(file("direct"),file("direct-copy"));
    expect(await compare("direct","direct-copy")).toMatchObject({restored:{requests:1,nonDelegatedRequests:1,
      attributedDelegatedRequests:0,unattributedDelegatedRequests:0},cancellationConfirmed:false});
  });
  it.each([
    ["requester",[requestUpdate,"UPDATE bigquery_cancellation_requests SET requested_by='google:replacement'"]],
    ["request-time",[requestUpdate,"UPDATE bigquery_cancellation_requests SET requested_at='2099-01-01T00:00:00.000Z'"]],
    ["claimant",[claimUpdate,"UPDATE dispatch_claims SET claimed_by='google:replacement'"]],
    ["cap",[claimUpdate,"UPDATE dispatch_claims SET maximum_bytes_billed=maximum_bytes_billed+1"]],
    ["claim-pin",[requestUpdate,claimUpdate,`UPDATE bigquery_cancellation_requests SET claim_body_digest='sha256:${"a".repeat(64)}'`,
      `UPDATE dispatch_claims SET compiled_body_digest='sha256:${"a".repeat(64)}'`]],
    ["audience",[requestUpdate,claimUpdate,bindingUpdate,"UPDATE bigquery_cancellation_requests SET delegation_audience='replacement'",
      "UPDATE dispatch_claims SET delegation_audience='replacement'","UPDATE bigquery_job_bindings SET delegation_audience='replacement'"]]
  ])("detects changed %s even when both snapshots contain one request",async (name,queries) => {
    await corrupted(name as string,queries as string[]);
    expect(await compare(name as string,"requested",1)).toMatchObject({requestComparison:"different",changed:1,referenceOnly:0,restoredOnly:0});
  });
  it.each([
    ["partial-audience",[requestUpdate,"UPDATE bigquery_cancellation_requests SET delegation_audience=NULL"]],
    ["partial-digest",[requestUpdate,"UPDATE bigquery_cancellation_requests SET claim_body_digest=NULL"]],
    ["wrong-audience",[requestUpdate,"UPDATE bigquery_cancellation_requests SET delegation_audience='wrong'"]],
    ["wrong-digest",[requestUpdate,`UPDATE bigquery_cancellation_requests SET claim_body_digest='sha256:${"b".repeat(64)}'`]],
    ["request-job",[requestUpdate,"UPDATE bigquery_cancellation_requests SET job_id='odap_wrong'"]],
    ["request-before-claim",[requestUpdate,"UPDATE bigquery_cancellation_requests SET requested_at='2000-01-01T00:00:00.000Z'"]],
    ["invalid-date",[requestUpdate,"UPDATE bigquery_cancellation_requests SET requested_at='2026-02-30T00:00:00.000Z'"]],
    ["blank-actor",[requestUpdate,"UPDATE bigquery_cancellation_requests SET requested_by=' '"]],
    ["control-actor",[requestUpdate,"UPDATE bigquery_cancellation_requests SET requested_by=char(10)"]],
    ["claim-time",[claimUpdate,"UPDATE dispatch_claims SET claimed_at='now'"]],
    ["claim-cap",[claimUpdate,"UPDATE dispatch_claims SET maximum_bytes_billed=0"]],
    ["claim-audience",[claimUpdate,"UPDATE dispatch_claims SET delegation_audience=NULL"]],
    ["binding-tag",[bindingUpdate,"UPDATE bigquery_job_bindings SET action_tag='wrong'"]],
    ["binding-project",[bindingUpdate,"UPDATE bigquery_job_bindings SET project_id='wrong/project'"]],
    ["orphan-claim",["DROP TRIGGER dispatch_claim_no_delete","DELETE FROM dispatch_claims"]],
    ["orphan-intent",["DROP TRIGGER intent_no_delete","DELETE FROM execution_intents"]]
  ])("rejects a malformed %s copy without reporting a partial comparison",async (name,queries) => {
    await corrupted(name as string,queries as string[]); await compare(name as string,"requested",2);
  });
  it("uses exact bound tenant scope and ignores unrelated tenant damage",async () => {
    await corrupted("peer-damage",["DROP TRIGGER cancellation_request_guard","DROP TRIGGER delegated_cancellation_guard",
      "INSERT INTO bigquery_cancellation_requests SELECT 'peer',intent_id,job_id,requested_by,requested_at,delegation_audience,claim_body_digest FROM bigquery_cancellation_requests"]);
    expect(await compare("requested","peer-damage")).toMatchObject({requestComparison:"equal"});
    await compare("requested","peer-damage",2,"peer");
    for(const tenant of ["T","missing","t' OR 1=1 --"," "]) await compare("requested","peer-damage",2,tenant);
  });
  it("reports an existing empty tenant without claiming no omitted cancellation or job",async () => {
    expect(await compare("requested","unrequested",0,"peer")).toMatchObject({restored:{requests:0},reference:{requests:0},
      cancellationConfirmed:false,issuerAuthenticated:false,retryAuthorized:false});
  });
  it.each(["tenant_id","intent_id"])("rejects a case-folded claim %s from a changed snapshot schema",async column => {
    const name="folded-"+column;
    await corrupted(name,["ALTER TABLE dispatch_claims RENAME TO retained_claims",
      `CREATE TABLE dispatch_claims(tenant_id TEXT COLLATE NOCASE,intent_id TEXT COLLATE NOCASE,
        claimed_by TEXT,claimed_at TEXT,maximum_bytes_billed INTEGER,delegation_audience TEXT,compiled_body_digest TEXT)`,
      `INSERT INTO dispatch_claims SELECT ${column==="tenant_id"?"upper(tenant_id)":"tenant_id"},
        ${column==="intent_id"?"upper(intent_id)":"intent_id"},claimed_by,claimed_at,maximum_bytes_billed,
        delegation_audience,compiled_body_digest FROM retained_claims`]);
    await compare(name,"requested",2);
  });
  it("rejects old-schema, repeated, linked, missing and journal-dependent inputs without creating files",async () => {
    await compare("pre34","requested",2); await compare("requested","requested",2);
    await link(file("requested"),file("hard-link")); await compare("hard-link","requested",2);
    await compare("missing","requested",2); expect(await readdir(dir)).not.toContain("missing.sqlite");
    for(const suffix of ["-wal","-shm","-journal"]) {
      const name="sidecar"+suffix; await copyFile(file("requested"),file(name));
      await writeFile(file(name)+suffix,"synthetic journal"); await compare(name,"requested",2);
    }
    await copyFile(file("requested"),file("wal-mode")); await jobSqlite(file("wal-mode"),"first","PRAGMA journal_mode=WAL");
    await compare("wal-mode","requested",2);
  });
  it("rejects a missing column even when the tenant has no requests",async () => {
    await corrupted("missing-column",["ALTER TABLE bigquery_cancellation_requests RENAME COLUMN claim_body_digest TO removed"],"unrequested");
    await compare("missing-column","unrequested",2);
  });
  it("bounds the inventory before validating or comparing any rows",async () => {
    const result=await exec(python,["-B","-c",`import importlib.util,sys
from pathlib import Path
sys.path.insert(0,'scripts')
spec=importlib.util.spec_from_file_location('checker','scripts/check-restore-cancellations.py')
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
assert module.MAX_ROWS == 10000
module.MAX_ROWS=0
try:
    module.requests(Path(sys.argv[1]),'t')
except ValueError as error:
    assert str(error) == 'inventory limit'
else:
    raise AssertionError('overflow accepted')
`,file("requested")]);
    expect(result.stdout).toBe(""); expect(result.stderr).toBe("");
  });
  it("requires explicit tenant scope",async () => {
    await expect(exec(python,["-B","scripts/check-restore-cancellations.py","--restored",file("requested"),
      "--reference",file("unrequested")])).rejects.toMatchObject({code:2,stdout:""});
  });
});
