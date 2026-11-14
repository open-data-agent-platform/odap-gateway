import { execFile } from "node:child_process";
import { copyFile, link, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prepareIntentJob } from "../lib/bigquery-job-storage";
import { retireSemanticRelease } from "../lib/semantic-candidate-storage";
import { jobDatabase, jobSqlite } from "./fixtures/job-sqlite";

const exec=promisify(execFile),python=process.env.ODAP_TEST_PYTHON||(process.platform==="win32"?"python":"python3");
let dir: string;
const file=(name: string)=>join(dir,name+".sqlite");
const sql=(name: string,query: string,params: string[]=[])=>jobSqlite(file(name),"run",query,params);
const access=(name: string)=>({db:jobDatabase(()=>file(name)),tenantId:"t",principalId:"owner"});
const claim="INSERT INTO dispatch_claims(tenant_id,intent_id,claimed_by,maximum_bytes_billed) VALUES('t','i','owner',64)";
const target={BIGQUERY_PROJECT_ID:"demo-project",BIGQUERY_LOCATION:"US"};
const releaseUpdate="DROP TRIGGER release_immutable_update",retirementUpdate="DROP TRIGGER retirement_no_update";
async function compare(restored: string,reference: string,code=0,tenant="t") {
  const r=await exec(python,["-B","scripts/check-restore-retirements.py","--restored",file(restored),
    "--reference",file(reference),"--tenant",tenant]).then(r=>({...r,code:0}),
    (e:{code:number;stdout:string;stderr:string})=>e);
  expect(r.code).toBe(code);
  if(code===2){expect(r.stdout).toBe("");expect(r.stderr.replace(/\r\n/g,"\n"))
    .toBe("No comparison: unusable standalone snapshots, tenant or retirement bindings.\n");return null;}
  expect(r.stderr).toBe("");expect(r.stdout).not.toMatch(/"owner"|"r"|"t"|sourceRevision|sha256:|superseded|SELECT |\.sqlite/);
  return JSON.parse(r.stdout);
}
async function corrupt(name: string,queries: string[],source="retired") {
  await copyFile(file(source),file(name));
  await exec(python,["-B","-c",`import json,sqlite3,sys
with sqlite3.connect(sys.argv[1]) as db:
    db.execute('PRAGMA ignore_check_constraints=ON')
    for query in json.loads(sys.argv[2]):
        db.execute(query)
`,file(name),JSON.stringify(queries)]);
}

describe("offline release retirement restore comparison",{timeout:25000},()=>{
  beforeAll(async()=>{
    vi.spyOn(globalThis,"fetch").mockRejectedValue(new Error("No network in restore comparison"));
    dir=await mkdtemp(join(tmpdir(),"odap-retirement-restore-"));
    await jobSqlite(file("live"),"setup-v32");
    await sql("live","INSERT INTO control_tenants VALUES('peer','Peer')");
    await sql("live","VACUUM INTO ?",[file("unprepared")]);
    expect(await retireSemanticRelease(access("unprepared"),"r","superseded")).toMatchObject({status:"retired"});
    await prepareIntentJob(access("live"),"i",target);
    await sql("live","VACUUM INTO ?",[file("unretired")]);
    expect(await retireSemanticRelease(access("live"),"r","superseded")).toMatchObject({status:"retired"});
    await sql("live","VACUUM INTO ?",[file("retired")]);
    await sql("live","UPDATE control_memberships SET active=0 WHERE tenant_id='t'");
    await sql("live","VACUUM INTO ?",[file("withdrawn")]);
    await jobSqlite(file("pre17"),"setup-v16");
    for(const name of ["legacy","legacy-claimed"]){
      await copyFile(file("pre17"),file(name));
      if(name==="legacy-claimed"){
        await prepareIntentJob(access(name),"i",target);await sql(name,claim);
      }
      await sql(name,"INSERT INTO dispatch_retired_releases VALUES('t','r','legacy reason')");
      await jobSqlite(file(name),"apply-semantic-retirement");
    }
  },90000);
  afterAll(async()=>{
    expect(globalThis.fetch).not.toHaveBeenCalled();vi.restoreAllMocks();
    if(dir)await rm(dir,{recursive:true,force:true});
  });
  it("preserves bytes, attribution and sidecar absence",async()=>{
    await copyFile(file("retired"),file("restored"));
    const paths=[file("restored"),file("retired")],before=await Promise.all(paths.map(p=>readFile(p))),names=await readdir(dir);
    expect(await compare("restored","retired")).toEqual({retirementComparison:"equal",referenceOnly:0,restoredOnly:0,changed:0,
      restored:{retirements:1,attributedRetirements:1,legacyRetirements:0},reference:{retirements:1,attributedRetirements:1,legacyRetirements:0},
      scope:"recorded-tenant-release-retirements-only",issuerAuthenticated:false,cancellationConfirmed:false,
      executionAuthorized:false,retryAuthorized:false,settlementAuthorized:false,servingAuthorized:false});
    for(let i=0;i<paths.length;i++)expect((await readFile(paths[i])).equals(before[i])).toBe(true);
    expect(await readdir(dir)).toEqual(names);
  });
  it("finds a lost retirement despite matching memberships, delegation history, stops and claims",async()=>{
    for(const script of ["memberships","dispatch","delegations","stops"]){
      const result=await exec(python,["-B",`scripts/check-restore-${script}.py`,"--restored",file("unretired"),
        "--reference",file("retired"),...(["delegations","stops"].includes(script)?["--tenant","t"]:[])]);
      expect(result.stderr).toBe("");expect(result.stdout).toContain('"equal"');
    }
    expect(await compare("unretired","retired",1)).toMatchObject({referenceOnly:1,changed:0,executionAuthorized:false});
    expect(await compare("retired","unretired",1)).toMatchObject({restoredOnly:1,referenceOnly:0});
    await copyFile(file("unretired"),file("stale-claim"));await copyFile(file("retired"),file("current-claim"));
    await expect(sql("current-claim",claim)).rejects.toThrow("semantic release retired");
    expect(await sql("stale-claim",claim)).toMatchObject({success:true,meta:{changes:1}});
    expect(await jobSqlite(file("current-claim"),"first","SELECT reserved_units,spent_units FROM control_budgets"))
      .toEqual({reserved_units:20,spent_units:0});
  });
  it("does not authorize serving from equally old empty copies",async()=>{
    await copyFile(file("unretired"),file("old-copy"));
    expect(await compare("unretired","old-copy")).toMatchObject({restored:{retirements:0},executionAuthorized:false,retryAuthorized:false,servingAuthorized:false});
  });
  it("retains history without a prepared job or current membership",async()=>{
    await copyFile(file("unprepared"),file("unprepared-copy"));
    expect(await compare("unprepared","unprepared-copy")).toMatchObject({retirementComparison:"equal",restored:{retirements:1}});
    expect(await compare("retired","withdrawn")).toMatchObject({retirementComparison:"equal",restored:{retirements:1}});
    await expect(retireSemanticRelease(access("withdrawn"),"r","again")).rejects.toThrow("unavailable");
  });
  it("retains legacy attribution gaps and claims without inventing cancellation or timestamps",async()=>{
    expect(await compare("legacy","legacy-claimed")).toMatchObject({retirementComparison:"equal",restored:{legacyRetirements:1,attributedRetirements:0},
      cancellationConfirmed:false,settlementAuthorized:false});
    expect(await retireSemanticRelease(access("legacy"),"r","again")).toEqual({status:"legacy_retired"});
    await expect(sql("legacy-claimed",claim)).rejects.toThrow("semantic release retired");
  });
  it.each([
    ["reason",[retirementUpdate,"UPDATE dispatch_retired_releases SET reason='replacement'"]],
    ["time",[retirementUpdate,"UPDATE dispatch_retired_releases SET retired_at='2099-01-01T00:00:00.000Z'"]],
    ["owner",[retirementUpdate,releaseUpdate,"UPDATE dispatch_retired_releases SET retired_by='other-owner'",
      "UPDATE semantic_releases SET payload=json_set(payload,'$.owner','other-owner')"]],
    ["digest",[releaseUpdate,`UPDATE semantic_releases SET payload=json_set(payload,'$.definitionDigest','sha256:${"a".repeat(64)}')`]],
    ["source",[releaseUpdate,"UPDATE semantic_releases SET payload=json_set(payload,'$.sourceRevision','s2')"]],
    ["creator",[releaseUpdate,"UPDATE semantic_releases SET created_by='other-creator'"]],
    ["creation",[releaseUpdate,"UPDATE semantic_releases SET created_at='2000-01-01T00:00:00.000Z'"]],
  ])("detects altered %s with equal retirement counts",async(name,queries)=>{
    await corrupt(name as string,queries as string[]);
    expect(await compare(name as string,"retired",1)).toMatchObject({changed:1,referenceOnly:0,restoredOnly:0});
  });
  it("allows JSON formatting differences and preserves multiline owner reasons",async()=>{
    await corrupt("json-format",[releaseUpdate,"UPDATE semantic_releases SET payload=json(payload)"]);
    expect(await compare("json-format","retired")).toMatchObject({retirementComparison:"equal"});
    await copyFile(file("unretired"),file("multiline"));
    await retireSemanticRelease(access("multiline"),"r","first line\nsecond\tline");
    await copyFile(file("multiline"),file("multiline-copy"));
    expect(await compare("multiline","multiline-copy")).toMatchObject({retirementComparison:"equal"});
  });
  it.each([
    ["partial-actor",[retirementUpdate,"UPDATE dispatch_retired_releases SET retired_by=NULL"]],
    ["partial-time",[retirementUpdate,"UPDATE dispatch_retired_releases SET retired_at=NULL"]],
    ["wrong-owner",[retirementUpdate,"UPDATE dispatch_retired_releases SET retired_by='not-owner'"]],
    ["blank-reason",[retirementUpdate,"UPDATE dispatch_retired_releases SET reason=' '"]],
    ["long-reason",[retirementUpdate,`UPDATE dispatch_retired_releases SET reason='${"x".repeat(1025)}'`]],
    ["nul-reason",[retirementUpdate,"UPDATE dispatch_retired_releases SET reason=char(0)"]],
    ["invalid-time",[retirementUpdate,"UPDATE dispatch_retired_releases SET retired_at='2026-02-30T00:00:00.000Z'"]],
    ["early-time",[retirementUpdate,"UPDATE dispatch_retired_releases SET retired_at='2000-01-01T00:00:00.000Z'"]],
    ["invalid-created",[releaseUpdate,"UPDATE semantic_releases SET created_at='invalid'"]],
    ["wrong-id",[releaseUpdate,"UPDATE semantic_releases SET payload=json_set(payload,'$.id','other')"]],
    ["wrong-tenant",[releaseUpdate,"UPDATE semantic_releases SET payload=json_set(payload,'$.tenantId','peer')"]],
    ["wrong-state",[releaseUpdate,"UPDATE semantic_releases SET payload=json_set(payload,'$.state','revoked')"]],
    ["unknown-version",[releaseUpdate,"UPDATE semantic_releases SET payload=json_set(payload,'$.schemaVersion','future')"]],
    ["extra-field",[releaseUpdate,"UPDATE semantic_releases SET payload=json_set(payload,'$.extra','x')"]],
    ["invalid-digest",[releaseUpdate,"UPDATE semantic_releases SET payload=json_set(payload,'$.definitionDigest','bad')"]],
    ["duplicate-json",[releaseUpdate,`UPDATE semantic_releases SET payload=substr(payload,1,length(payload)-1)||',"id":"r"}'`]],
    ["missing-release",["DROP TRIGGER release_immutable_delete","DELETE FROM semantic_releases"]],
    ["missing-tenant",["DELETE FROM control_tenants"]],
    ["duplicate-marker",["ALTER TABLE dispatch_retired_releases RENAME TO retained_retirements",
      "CREATE TABLE dispatch_retired_releases AS SELECT * FROM retained_retirements UNION ALL SELECT * FROM retained_retirements"]],
  ])("rejects %s without leaking records or partial output",async(name,queries)=>{
    await corrupt(name as string,queries as string[]);await compare(name as string,"retired",2);
  });
  it("uses exact tenant scope while preserving unrelated tenant isolation",async()=>{
    await corrupt("peer-damage",["DROP TRIGGER guard_semantic_retirement","DROP TRIGGER audit_semantic_retirement",
      "INSERT INTO dispatch_retired_releases SELECT 'peer',release_id,reason,retired_by,retired_at FROM dispatch_retired_releases"]);
    expect(await compare("retired","peer-damage")).toMatchObject({retirementComparison:"equal"});
    await compare("retired","peer-damage",2,"peer");
    for(const tenant of ["T","missing","t' OR 1=1 --"," "])await compare("retired","peer-damage",2,tenant);
    expect(await compare("retired","unretired",0,"peer")).toMatchObject({restored:{retirements:0},servingAuthorized:false});
  });
  it.each(["tenant_id","id"])("rejects case-folded release %s joins",async column=>{
    await corrupt("folded-"+column,["ALTER TABLE semantic_releases RENAME TO retained_releases",
      "CREATE TABLE semantic_releases(tenant_id TEXT COLLATE NOCASE,id TEXT COLLATE NOCASE,payload TEXT,created_by TEXT,created_at TEXT)",
      `INSERT INTO semantic_releases SELECT ${column==="tenant_id"?"upper(tenant_id)":"tenant_id"},${column==="id"?"upper(id)":"id"},payload,created_by,created_at FROM retained_releases`]);
    await compare("folded-"+column,"retired",2);
  });
  it("rejects missing columns or table-impersonating views for empty histories",async()=>{
    await corrupt("missing-column",["ALTER TABLE dispatch_retired_releases RENAME COLUMN retired_at TO removed"],"unretired");
    await compare("missing-column","unretired",2);
    await corrupt("view",["ALTER TABLE dispatch_retired_releases RENAME TO retained_retirements",
      "CREATE VIEW dispatch_retired_releases AS SELECT * FROM retained_retirements"],"unretired");
    await compare("view","unretired",2);
  });
  it("rejects old-schema, same, hard-linked, missing and journal-dependent files",async()=>{
    await compare("pre17","retired",2);await compare("retired","retired",2);
    await link(file("retired"),file("hard-link"));await compare("hard-link","retired",2);
    await compare("missing","retired",2);expect(await readdir(dir)).not.toContain("missing.sqlite");
    for(const suffix of ["-wal","-shm","-journal"]){
      const name="sidecar"+suffix;await copyFile(file("retired"),file(name));
      await writeFile(file(name)+suffix,"synthetic journal");await compare(name,"retired",2);
    }
    await copyFile(file("retired"),file("wal-mode"));await jobSqlite(file("wal-mode"),"first","PRAGMA journal_mode=WAL");
    await compare("wal-mode","retired",2);
  });
  it("bounds the inventory before comparing rows",async()=>{
    await exec(python,["-B","-c",`import importlib.util,sys
from pathlib import Path
sys.path.insert(0,'scripts')
spec=importlib.util.spec_from_file_location('checker','scripts/check-restore-retirements.py')
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
assert module.MAX_ROWS == 10000
module.MAX_ROWS=0
try:
    module.retirements(Path(sys.argv[1]),'t')
except ValueError as error:
    assert str(error) == 'inventory limit'
else:
    raise AssertionError('overflow accepted')
`,file("retired")]);
  });
  it("requires explicit tenant scope",async()=>{
    await expect(exec(python,["-B","scripts/check-restore-retirements.py","--restored",file("retired"),
      "--reference",file("unretired")])).rejects.toMatchObject({code:2,stdout:""});
  });
});
