import { execFile } from "node:child_process";
import { copyFile, link, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { approveSemanticRevision, promoteSemanticRevision, proposeSemanticRevision,
  recordSemanticValidation, withdrawSemanticApproval } from "../lib/semantic-candidate-storage";
import { jobDatabase, jobSqlite } from "./fixtures/job-sqlite";
import metric from "./fixtures/revenue-metric.json";

const exec=promisify(execFile),python=process.env.ODAP_TEST_PYTHON||(process.platform==="win32"?"python":"python3");
let dir: string;
const file=(name: string)=>join(dir,name+".sqlite");
const sql=(name: string,query: string,params: string[]=[])=>jobSqlite(file(name),"run",query,params);
const access=(name: string)=>({db:jobDatabase(()=>file(name)),tenantId:"t",principalId:"owner"});
const input={revisionId:"rev",approvalId:"dec",releaseId:"new"};
const withdrawal={revisionId:"rev",approvalId:"dec",reason:"fixture:correct-definition"};
const w="DROP TRIGGER withdrawal_no_update",a="DROP TRIGGER candidate_approval_no_update",
  r="DROP TRIGGER candidate_revision_no_update",v="DROP TRIGGER candidate_validation_no_update";
async function compare(restored: string,reference: string,code=0,tenant="t") {
  const result=await exec(python,["-B","scripts/check-restore-withdrawals.py","--restored",file(restored),
    "--reference",file(reference),"--tenant",tenant]).then(r=>({...r,code:0}),
    (e:{code:number;stdout:string;stderr:string})=>e);
  expect(result.code).toBe(code);
  if(code===2){expect(result.stdout).toBe("");expect(result.stderr.replace(/\r\n/g,"\n"))
    .toBe("No comparison: unusable standalone snapshots, tenant or withdrawal bindings.\n");return null;}
  expect(result.stderr).toBe("");expect(result.stdout).not.toMatch(/"owner"|"rev"|"dec"|"t"|sha256:|fixture:|SELECT |\.sqlite/);
  return JSON.parse(result.stdout);
}
async function corrupt(name: string,queries: string[],source="withdrawn") {
  await copyFile(file(source),file(name));
  await exec(python,["-B","-c",`import json,sqlite3,sys
with sqlite3.connect(sys.argv[1]) as db:
    db.execute('PRAGMA ignore_check_constraints=ON')
    for query in json.loads(sys.argv[2]):
        db.execute(query)
`,file(name),JSON.stringify(queries)]);
}

describe("offline approval withdrawal restore comparison",{timeout:25000},()=>{
  beforeAll(async()=>{
    vi.spyOn(globalThis,"fetch").mockRejectedValue(new Error("No network in restore comparison"));
    dir=await mkdtemp(join(tmpdir(),"odap-withdrawal-restore-"));
    await jobSqlite(file("live"),"setup-v32");
    await sql("live","INSERT INTO control_tenants VALUES('peer','Peer')");
    const proposed=await proposeSemanticRevision(access("live"),{revisionId:"rev",ownerId:"owner",
      provenanceRef:"fixture:catalog",definitionJson:JSON.stringify(metric)});
    await recordSemanticValidation(access("live"),"rev",proposed.definitionDigest,"fixture:review");
    await approveSemanticRevision(access("live"),{...input,reviewedDigest:proposed.definitionDigest,evidenceRef:"fixture:review"});
    await sql("live","INSERT INTO semantic_source_heads VALUES('t','orders','demo-project','analytics','orders','s1')");
    await sql("live","VACUUM INTO ?",[file("approved")]);
    expect(await withdrawSemanticApproval(access("live"),withdrawal)).toMatchObject({status:"withdrawn"});
    await sql("live","VACUUM INTO ?",[file("withdrawn")]);
    await sql("live","UPDATE control_memberships SET active=0 WHERE tenant_id='t'");
    await sql("live","UPDATE semantic_source_heads SET source_revision='s2'");
    await sql("live","VACUUM INTO ?",[file("changed-authority")]);
    await jobSqlite(file("pre16"),"setup-v14");await jobSqlite(file("pre16"),"apply-semantic-promotion");
  },90000);
  afterAll(async()=>{
    expect(globalThis.fetch).not.toHaveBeenCalled();vi.restoreAllMocks();
    if(dir)await rm(dir,{recursive:true,force:true});
  });
  it("preserves snapshot bytes and sidecar absence without authorizing publication",async()=>{
    await copyFile(file("withdrawn"),file("restored"));
    const paths=[file("restored"),file("withdrawn")],before=await Promise.all(paths.map(p=>readFile(p))),names=await readdir(dir);
    expect(await compare("restored","withdrawn")).toEqual({withdrawalComparison:"equal",referenceOnly:0,restoredOnly:0,changed:0,
      restored:{withdrawals:1},reference:{withdrawals:1},scope:"recorded-tenant-approval-withdrawals-only",
      issuerAuthenticated:false,definitionValidated:false,publicationAuthorized:false,executionAuthorized:false,retryAuthorized:false,servingAuthorized:false});
    for(let i=0;i<paths.length;i++)expect((await readFile(paths[i])).equals(before[i])).toBe(true);
    expect(await readdir(dir)).toEqual(names);
  });
  it("detects lost withdrawal when other recovery inventories match and an old copy permits publication",async()=>{
    for(const script of ["memberships","dispatch","delegations","stops","retirements"]){
      const result=await exec(python,["-B",`scripts/check-restore-${script}.py`,"--restored",file("approved"),
        "--reference",file("withdrawn"),...(["memberships","dispatch"].includes(script)?[]:["--tenant","t"])]);
      expect(result.stderr).toBe("");expect(result.stdout).toContain('"equal"');
    }
    expect(await compare("approved","withdrawn",1)).toMatchObject({referenceOnly:1,changed:0,publicationAuthorized:false});
    expect(await compare("withdrawn","approved",1)).toMatchObject({restoredOnly:1,referenceOnly:0});
    await copyFile(file("approved"),file("old-publication"));await copyFile(file("withdrawn"),file("current-publication"));
    await expect(promoteSemanticRevision(access("current-publication"),input)).rejects.toThrow("semantic promotion unavailable");
    expect(await promoteSemanticRevision(access("old-publication"),input)).toEqual({releaseId:"new"});
    for(const [name,n] of [["old-publication",1],["current-publication",0]] as const){
      expect(await jobSqlite(file(name),"readonly-first",`SELECT
        (SELECT count(*) FROM semantic_release_promotions) AS links,
        (SELECT count(*) FROM semantic_releases WHERE id='new') AS releases,
        (SELECT count(*) FROM control_object_events WHERE object_kind='release' AND object_id='new') AS events`))
        .toEqual({links:n,releases:n,events:n});
    }
  });
  it("does not trust two equally old empty histories",async()=>{
    await copyFile(file("approved"),file("old-copy"));
    expect(await compare("approved","old-copy")).toMatchObject({restored:{withdrawals:0},publicationAuthorized:false,servingAuthorized:false});
  });
  it("retains original history after current authority and source changes",async()=>{
    expect(await compare("withdrawn","changed-authority")).toMatchObject({withdrawalComparison:"equal",restored:{withdrawals:1}});
    await expect(withdrawSemanticApproval(access("changed-authority"),withdrawal)).rejects.toThrow("unavailable");
  });
  it("preserves legitimate multiline owner reasons",async()=>{
    await copyFile(file("approved"),file("multiline"));
    await withdrawSemanticApproval(access("multiline"),{...withdrawal,reason:"first line\nsecond\tline"});
    await copyFile(file("multiline"),file("multiline-copy"));
    expect(await compare("multiline","multiline-copy")).toMatchObject({withdrawalComparison:"equal"});
  });
  it.each([
    ["reason",[w,"UPDATE semantic_approval_withdrawals SET reason='replacement'"]],
    ["withdrawal-time",[w,"UPDATE semantic_approval_withdrawals SET withdrawn_at='2099-01-01T00:00:00.000Z'"]],
    ["provenance",[r,"UPDATE semantic_candidate_revisions SET provenance_ref='fixture:other'"]],
    ["proposer",[r,"UPDATE semantic_candidate_revisions SET proposed_by='other'"]],
    ["proposal-time",[r,"UPDATE semantic_candidate_revisions SET proposed_at='2000-01-01T00:00:00.000Z'"]],
    ["review-evidence",[v,"UPDATE semantic_candidate_validations SET evidence_ref='fixture:other-review'"]],
    ["owner-chain",[w,a,r,v,"UPDATE semantic_approval_withdrawals SET withdrawn_by='other-owner'",
      "UPDATE semantic_candidate_approvals SET approved_by='other-owner'","UPDATE semantic_candidate_revisions SET owner_id='other-owner'",
      "UPDATE semantic_candidate_validations SET validated_by='other-owner'"]],
  ])("detects changed %s at equal withdrawal counts",async(name,queries)=>{
    await corrupt(name as string,queries as string[]);
    expect(await compare(name as string,"withdrawn",1)).toMatchObject({changed:1,referenceOnly:0,restoredOnly:0});
  });
  it.each([
    ["actor",[w,"UPDATE semantic_approval_withdrawals SET withdrawn_by='other'"]],
    ["revision",[w,"UPDATE semantic_approval_withdrawals SET revision_id='missing'"]],
    ["approval-revision",[a,"UPDATE semantic_candidate_approvals SET revision_id='missing'"]],
    ["validator",[v,"UPDATE semantic_candidate_validations SET validated_by='other'"]],
    ["blank-reason",[w,"UPDATE semantic_approval_withdrawals SET reason=' '"]],
    ["long-reason",[w,`UPDATE semantic_approval_withdrawals SET reason='${"x".repeat(1025)}'`]],
    ["nul-reason",[w,"UPDATE semantic_approval_withdrawals SET reason=char(0)"]],
    ["invalid-time",[w,"UPDATE semantic_approval_withdrawals SET withdrawn_at='2026-02-30T00:00:00.000Z'"]],
    ["early-withdrawal",[w,"UPDATE semantic_approval_withdrawals SET withdrawn_at='2000-01-01T00:00:00.000Z'"]],
    ["early-approval",[a,"UPDATE semantic_candidate_approvals SET approved_at='2000-01-01T00:00:00.000Z'"]],
    ["late-validation",[v,"UPDATE semantic_candidate_validations SET validated_at='2099-01-01T00:00:00.000Z'"]],
    ["digest",[r,`UPDATE semantic_candidate_revisions SET definition_digest='sha256:${"a".repeat(64)}'`]],
    ["validation-digest",[v,`UPDATE semantic_candidate_validations SET definition_digest='sha256:${"b".repeat(64)}'`]],
    ["changed-definition",[r,"UPDATE semantic_candidate_revisions SET definition_json=json_set(definition_json,'$.sourceRevision','s2')"]],
    ["reformatted-definition",[r,"UPDATE semantic_candidate_revisions SET definition_json=' '||definition_json"]],
    ["duplicate-json",[r,`UPDATE semantic_candidate_revisions SET definition_json=substr(definition_json,1,length(definition_json)-1)||',"tenantId":"t"}'`]],
    ["nonfinite-json",[r,`UPDATE semantic_candidate_revisions SET definition_json='{"value":NaN}'`]],
    ["missing-approval",["DROP TRIGGER candidate_approval_no_delete","DELETE FROM semantic_candidate_approvals"]],
    ["missing-validation",["DROP TRIGGER candidate_validation_no_delete","DELETE FROM semantic_candidate_validations"]],
    ["missing-revision",["DROP TRIGGER candidate_revision_no_delete","DELETE FROM semantic_candidate_revisions"]],
    ["missing-tenant",["DELETE FROM control_tenants"]],
    ["duplicate-marker",["ALTER TABLE semantic_approval_withdrawals RENAME TO retained_withdrawals",
      "CREATE TABLE semantic_approval_withdrawals AS SELECT * FROM retained_withdrawals UNION ALL SELECT * FROM retained_withdrawals"]],
    ["promoted-approval",["ALTER TABLE semantic_release_promotions RENAME TO retained_promotions",
      "CREATE TABLE semantic_release_promotions AS SELECT * FROM retained_promotions",
      "INSERT INTO semantic_release_promotions VALUES('t','dec','other-revision','r','owner')"]],
    ["promoted-revision",["ALTER TABLE semantic_release_promotions RENAME TO retained_promotions",
      "CREATE TABLE semantic_release_promotions AS SELECT * FROM retained_promotions",
      "INSERT INTO semantic_release_promotions VALUES('t','other-approval','rev','r','owner')"]],
  ])("rejects %s without identifiers or partial output",async(name,queries)=>{
    await corrupt(name as string,queries as string[]);await compare(name as string,"withdrawn",2);
  });
  it("uses exact tenant scope without reading unrelated withdrawal history",async()=>{
    await corrupt("peer-damage",["DROP TRIGGER guard_approval_withdrawal","DROP TRIGGER audit_approval_withdrawal",
      "INSERT INTO semantic_approval_withdrawals SELECT 'peer',approval_id,revision_id,withdrawn_by,reason,withdrawn_at FROM semantic_approval_withdrawals"]);
    expect(await compare("withdrawn","peer-damage")).toMatchObject({withdrawalComparison:"equal"});
    await compare("withdrawn","peer-damage",2,"peer");
    for(const tenant of ["T","missing","t' OR 1=1 --"," "])await compare("withdrawn","peer-damage",2,tenant);
    expect(await compare("withdrawn","approved",0,"peer")).toMatchObject({restored:{withdrawals:0},publicationAuthorized:false});
  });
  it.each(["tenant_id","id"])("rejects case-folded approval %s joins",async column=>{
    await corrupt("folded-"+column,["ALTER TABLE semantic_candidate_approvals RENAME TO retained_approvals",
      "CREATE TABLE semantic_candidate_approvals(tenant_id TEXT COLLATE NOCASE,id TEXT COLLATE NOCASE,revision_id TEXT,approved_by TEXT,approved_at TEXT)",
      `INSERT INTO semantic_candidate_approvals SELECT ${column==="tenant_id"?"upper(tenant_id)":"tenant_id"},${column==="id"?"upper(id)":"id"},revision_id,approved_by,approved_at FROM retained_approvals`]);
    await compare("folded-"+column,"withdrawn",2);
  });
  it("rejects missing columns and table-impersonating views even for empty histories",async()=>{
    await corrupt("missing-column",["ALTER TABLE semantic_approval_withdrawals RENAME COLUMN withdrawn_at TO removed"],"approved");
    await compare("missing-column","approved",2);
    await corrupt("view",["ALTER TABLE semantic_approval_withdrawals RENAME TO retained_withdrawals",
      "CREATE VIEW semantic_approval_withdrawals AS SELECT * FROM retained_withdrawals"],"approved");
    await compare("view","approved",2);
  });
  it("rejects old-schema, same, hard-linked, missing and journal-dependent inputs",async()=>{
    await compare("pre16","withdrawn",2);await compare("withdrawn","withdrawn",2);
    await link(file("withdrawn"),file("hard-link"));await compare("hard-link","withdrawn",2);
    await compare("missing","withdrawn",2);expect(await readdir(dir)).not.toContain("missing.sqlite");
    for(const suffix of ["-wal","-shm","-journal"]){
      const name="sidecar"+suffix;await copyFile(file("withdrawn"),file(name));
      await writeFile(file(name)+suffix,"synthetic journal");await compare(name,"withdrawn",2);
    }
    await copyFile(file("withdrawn"),file("wal-mode"));await jobSqlite(file("wal-mode"),"first","PRAGMA journal_mode=WAL");
    await compare("wal-mode","withdrawn",2);
  });
  it("bounds the inventory before comparison",async()=>{
    await exec(python,["-B","-c",`import importlib.util,sys
from pathlib import Path
sys.path.insert(0,'scripts')
spec=importlib.util.spec_from_file_location('checker','scripts/check-restore-withdrawals.py')
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
assert module.MAX_ROWS == 10000
module.MAX_ROWS=0
try:
    module.withdrawals(Path(sys.argv[1]),'t')
except ValueError as error:
    assert str(error) == 'inventory limit'
else:
    raise AssertionError('overflow accepted')
`,file("withdrawn")]);
  });
  it("requires an explicit tenant",async()=>{
    await expect(exec(python,["-B","scripts/check-restore-withdrawals.py","--restored",file("withdrawn"),
      "--reference",file("approved")])).rejects.toMatchObject({code:2,stdout:""});
  });
});
