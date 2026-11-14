import { execFile } from "node:child_process";
import { copyFile, link, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prepareIntentJob } from "../lib/bigquery-job-storage";
import { readPreDispatchStop, stopBeforeDispatch } from "../lib/pre-dispatch-stop";
import { jobDatabase, jobSqlite } from "./fixtures/job-sqlite";

const exec = promisify(execFile);
const python = process.env.ODAP_TEST_PYTHON || (process.platform === "win32" ? "python" : "python3");
let dir: string, recorded: Awaited<ReturnType<typeof stopBeforeDispatch>>;
const file = (name: string) => join(dir,name+".sqlite");
const access = (name: string, readonly = false) => ({db:jobDatabase(() => file(name),readonly ? "readonly" : "readwrite"),
  tenantId:"t",principalId:"owner"});
const sql = (name: string, query: string, params: string[] = []) => jobSqlite(file(name),"run",query,params);
async function compare(restored: string, reference: string, code = 0, tenant = "t") {
  const result = await exec(python,["-B","scripts/check-restore-stops.py","--restored",file(restored),
    "--reference",file(reference),"--tenant",tenant]).then(r => ({...r,code:0}),
    (e: {code:number;stdout:string;stderr:string}) => e);
  expect(result.code).toBe(code);
  if(code === 2) {
    expect(result.stdout).toBe("");
    expect(result.stderr.replace(/\r\n/g,"\n")).toBe("No comparison: unusable standalone snapshots, tenant or stop bindings.\n");
    return null;
  }
  expect(result.stderr).toBe("");
  expect(result.stdout).not.toMatch(/owner_requested_stop|"i"|"owner"|"user"|sha256:|SELECT |\.sqlite/);
  return JSON.parse(result.stdout);
}
async function corrupted(name: string, queries: string[], source = "stopped") {
  await copyFile(file(source),file(name));
  await exec(python,["-B","-c",`import json,sqlite3,sys
with sqlite3.connect(sys.argv[1]) as db:
    db.execute('PRAGMA ignore_check_constraints=ON')
    for query in json.loads(sys.argv[2]):
        db.execute(query)
`,file(name),JSON.stringify(queries)]);
}
const stopUpdate="DROP TRIGGER pre_dispatch_stop_no_update", intentUpdate="DROP TRIGGER intent_no_update";

describe("offline pre-dispatch stop restore comparison", {timeout:25000}, () => {
  beforeAll(async () => {
    vi.spyOn(globalThis,"fetch").mockRejectedValue(new Error("No network in restore comparison"));
    dir=await mkdtemp(join(tmpdir(),"odap-stop-restore-"));
    await jobSqlite(file("live"),"setup-v32");
    await sql("live","INSERT INTO control_tenants VALUES('peer','Peer')");
    await sql("live","VACUUM INTO ?",[file("unprepared")]);
    await stopBeforeDispatch(access("unprepared"),"i");
    await prepareIntentJob(access("live"),"i",{BIGQUERY_PROJECT_ID:"demo-project",BIGQUERY_LOCATION:"US"});
    await sql("live","VACUUM INTO ?",[file("unstopped")]);
    recorded=await stopBeforeDispatch(access("live"),"i");
    await sql("live","VACUUM INTO ?",[file("stopped")]);
    await sql("live",`INSERT INTO dispatch_retired_releases(tenant_id,release_id,reason,retired_by,retired_at)
      VALUES('t','r','retired','owner',strftime('%Y-%m-%dT%H:%M:%fZ','now'))`);
    await sql("live","UPDATE control_memberships SET active=0 WHERE tenant_id='t'");
    await sql("live","VACUUM INTO ?",[file("revoked")]);
    await jobSqlite(file("pre11"),"setup-v10");
    await sql("pre11","INSERT INTO dispatch_stopped_intents VALUES('t','i','legacy retained reason')");
    for(const name of ["legacy","legacy-claimed"]) {
      await copyFile(file("pre11"),file(name));
      if(name==="legacy-claimed") {
        await prepareIntentJob(access(name),"i",{BIGQUERY_PROJECT_ID:"demo-project",BIGQUERY_LOCATION:"US"});
        await sql(name,"INSERT INTO dispatch_claims(tenant_id,intent_id,claimed_by,maximum_bytes_billed) VALUES('t','i','owner',64)");
      }
      await jobSqlite(file(name),"apply-pre-dispatch-stop");
    }
  },90000);
  afterAll(async () => {
    expect(globalThis.fetch).not.toHaveBeenCalled(); vi.restoreAllMocks();
    if(dir) await rm(dir,{recursive:true,force:true});
  });

  it("preserves bytes, attribution and sidecar absence across detached copies",async () => {
    await copyFile(file("stopped"),file("restored"));
    const paths=[file("stopped"),file("restored")],before=await Promise.all(paths.map(p=>readFile(p))),names=await readdir(dir);
    const report=await compare("restored","stopped");
    expect(report).toEqual({stopComparison:"equal",referenceOnly:0,restoredOnly:0,changed:0,
      restored:{stops:1,attributedStops:1,legacyStops:0},reference:{stops:1,attributedStops:1,legacyStops:0},
      scope:"recorded-tenant-dispatch-stops-only",issuerAuthenticated:false,cancellationConfirmed:false,
      executionAuthorized:false,retryAuthorized:false,settlementAuthorized:false,servingAuthorized:false});
    expect(await readPreDispatchStop(access("restored",true),"i")).toEqual(recorded);
    for(let i=0;i<paths.length;i++) expect((await readFile(paths[i])).equals(before[i])).toBe(true);
    expect(await readdir(dir)).toEqual(names);
  });
  it("detects a lost stop when membership and claimed-job comparisons both match",async () => {
    for(const script of ["memberships","dispatch"]) {
      const result=await exec(python,["-B",`scripts/check-restore-${script}.py`,"--restored",file("unstopped"),"--reference",file("stopped")]);
      expect(result.stderr).toBe(""); expect(JSON.parse(result.stdout).referenceOnly).toBe(0);
    }
    expect(await compare("unstopped","stopped",1)).toMatchObject({referenceOnly:1,restoredOnly:0,changed:0,executionAuthorized:false});
    expect(await compare("stopped","unstopped",1)).toMatchObject({referenceOnly:0,restoredOnly:1,changed:0});
    await expect(sql("stopped","INSERT INTO dispatch_claims(tenant_id,intent_id,claimed_by,maximum_bytes_billed) VALUES('t','i','owner',64)"))
      .rejects.toThrow("dispatch stopped");
    expect(await jobSqlite(file("stopped"),"first","SELECT reserved_units,spent_units FROM control_budgets"))
      .toEqual({reserved_units:20,spent_units:0});
  });
  it("does not authorize replay from two equally old empty copies",async () => {
    await copyFile(file("unstopped"),file("old-copy"));
    expect(await compare("unstopped","old-copy")).toMatchObject({stopComparison:"equal",restored:{stops:0},
      executionAuthorized:false,retryAuthorized:false,servingAuthorized:false});
  });
  it("includes stops without job preparation and keeps history after owner or release revocation",async () => {
    await copyFile(file("unprepared"),file("unprepared-copy"));
    expect(await compare("unprepared","unprepared-copy")).toMatchObject({restored:{stops:1,attributedStops:1}});
    expect(await compare("stopped","revoked")).toMatchObject({stopComparison:"equal",restored:{stops:1},servingAuthorized:false});
    await expect(readPreDispatchStop(access("revoked",true),"i")).rejects.toThrow("unavailable");
  });
  it("retains legacy reasons without inventing attribution or hiding a prior claim",async () => {
    expect(await compare("legacy","legacy-claimed")).toMatchObject({stopComparison:"equal",restored:{stops:1,legacyStops:1,attributedStops:0},
      cancellationConfirmed:false,executionAuthorized:false});
    expect(await readPreDispatchStop(access("legacy-claimed",true),"i")).toEqual({state:"already-claimed"});
    expect(await compare("legacy","stopped",1)).toMatchObject({changed:1,reference:{attributedStops:1}});
  });
  it.each([
    ["actor",[stopUpdate,"UPDATE dispatch_stopped_intents SET stopped_by='replacement-owner'"]],
    ["time",[stopUpdate,"UPDATE dispatch_stopped_intents SET stopped_at='2099-01-01T00:00:00.000Z'"]],
    ["action",[intentUpdate,`UPDATE execution_intents SET action_digest='sha256:${"a".repeat(64)}'`]],
    ["contract",[intentUpdate,"UPDATE execution_intents SET contract_id='replacement-contract'"]],
    ["principal",[intentUpdate,"UPDATE execution_intents SET principal_id='replacement-principal'"]],
    ["budget",[intentUpdate,"UPDATE execution_intents SET budget_id='replacement-budget'"]],
    ["reservation",[intentUpdate,"UPDATE execution_intents SET reservation_id='replacement-reservation'"]],
    ["units",[intentUpdate,"UPDATE execution_intents SET reserved_units=21"]],
  ])("detects altered %s with equal stop counts",async(name,queries) => {
    await corrupted(name as string,queries as string[]);
    expect(await compare(name as string,"stopped",1)).toMatchObject({changed:1,referenceOnly:0,restoredOnly:0});
  });
  it("detects changes to a legacy reason without relabeling the marker",async () => {
    await corrupted("legacy-reason",[stopUpdate,"UPDATE dispatch_stopped_intents SET reason='different legacy reason'"],"legacy");
    expect(await compare("legacy-reason","legacy",1)).toMatchObject({changed:1,restored:{legacyStops:1,attributedStops:0}});
  });
  it("accepts a zero reservation without interpreting it as a refund or permission",async () => {
    await corrupted("zero",[intentUpdate,"UPDATE execution_intents SET reserved_units=0"]);
    await copyFile(file("zero"),file("zero-copy"));
    expect(await compare("zero","zero-copy")).toMatchObject({stopComparison:"equal",restored:{stops:1},
      executionAuthorized:false,settlementAuthorized:false});
    expect(await compare("zero","stopped",1)).toMatchObject({changed:1});
  });
  it.each([
    ["partial-actor",[stopUpdate,"UPDATE dispatch_stopped_intents SET stopped_by=NULL"]],
    ["partial-time",[stopUpdate,"UPDATE dispatch_stopped_intents SET stopped_at=NULL"]],
    ["blank-actor",[stopUpdate,"UPDATE dispatch_stopped_intents SET stopped_by=' '"]],
    ["long-actor",[stopUpdate,`UPDATE dispatch_stopped_intents SET stopped_by='${"x".repeat(513)}'`]],
    ["control-actor",[stopUpdate,"UPDATE dispatch_stopped_intents SET stopped_by=char(10)"]],
    ["blank-reason",[stopUpdate,"UPDATE dispatch_stopped_intents SET reason=' '"]],
    ["wrong-reason",[stopUpdate,"UPDATE dispatch_stopped_intents SET reason='legacy'"]],
    ["invalid-time",[stopUpdate,"UPDATE dispatch_stopped_intents SET stopped_at='2026-02-30T00:00:00.000Z'"]],
    ["noncanonical-time",[stopUpdate,"UPDATE dispatch_stopped_intents SET stopped_at='2026-01-01'"]],
    ["invalid-digest",[intentUpdate,"UPDATE execution_intents SET action_digest='invalid'"]],
    ["negative-units",[intentUpdate,"UPDATE execution_intents SET reserved_units=-1"]],
    ["unsafe-units",[intentUpdate,"UPDATE execution_intents SET reserved_units=9007199254740992"]],
    ["missing-intent",["DROP TRIGGER intent_no_delete","DELETE FROM execution_intents"]],
    ["missing-tenant",["DELETE FROM control_tenants"]],
    ["duplicate-stop",["ALTER TABLE dispatch_stopped_intents RENAME TO retained_stops",
      "CREATE TABLE dispatch_stopped_intents AS SELECT * FROM retained_stops UNION ALL SELECT * FROM retained_stops"]],
  ])("rejects %s without leaking values or emitting a partial comparison",async(name,queries) => {
    await corrupted(name as string,queries as string[]); await compare(name as string,"stopped",2);
  });
  it("uses exact tenant scope and ignores unrelated malformed markers",async () => {
    await corrupted("peer-damage",["DROP TRIGGER pre_dispatch_stop_guard",
      "INSERT INTO dispatch_stopped_intents SELECT 'peer',intent_id,reason,stopped_by,stopped_at FROM dispatch_stopped_intents"]);
    expect(await compare("stopped","peer-damage")).toMatchObject({stopComparison:"equal"});
    await compare("stopped","peer-damage",2,"peer");
    for(const tenant of ["T","missing","t' OR 1=1 --"," "]) await compare("stopped","peer-damage",2,tenant);
    expect(await compare("stopped","unstopped",0,"peer")).toMatchObject({restored:{stops:0},reference:{stops:0},servingAuthorized:false});
  });
  it.each(["tenant_id","id"])("rejects case-folded intent %s joins from changed schemas",async column => {
    const name="folded-"+column;
    await corrupted(name,["ALTER TABLE execution_intents RENAME TO retained_intents",
      `CREATE TABLE execution_intents(tenant_id TEXT COLLATE NOCASE,id TEXT COLLATE NOCASE,contract_id TEXT,budget_id TEXT,
        reservation_id TEXT,principal_id TEXT,action_digest TEXT,reserved_units INTEGER,created_at TEXT)`,
      `INSERT INTO execution_intents SELECT ${column==="tenant_id"?"upper(tenant_id)":"tenant_id"},${column==="id"?"upper(id)":"id"},
        contract_id,budget_id,reservation_id,principal_id,action_digest,reserved_units,created_at FROM retained_intents`]);
    await compare(name,"stopped",2);
  });
  it("rejects missing columns and a view impersonating a required table even with no stops",async () => {
    await corrupted("missing-column",["ALTER TABLE dispatch_stopped_intents RENAME COLUMN stopped_at TO removed"],"unstopped");
    await compare("missing-column","unstopped",2);
    await corrupted("view",["ALTER TABLE dispatch_stopped_intents RENAME TO retained_stops",
      "CREATE VIEW dispatch_stopped_intents AS SELECT * FROM retained_stops"],"unstopped");
    await compare("view","unstopped",2);
  });
  it("rejects old-schema, same, hard-linked, missing and journal-dependent files",async () => {
    await compare("pre11","stopped",2); await compare("stopped","stopped",2);
    await link(file("stopped"),file("hard-link")); await compare("hard-link","stopped",2);
    await compare("missing","stopped",2); expect(await readdir(dir)).not.toContain("missing.sqlite");
    for(const suffix of ["-wal","-shm","-journal"]) {
      const name="sidecar"+suffix; await copyFile(file("stopped"),file(name));
      await writeFile(file(name)+suffix,"synthetic journal"); await compare(name,"stopped",2);
    }
    await copyFile(file("stopped"),file("wal-mode")); await jobSqlite(file("wal-mode"),"first","PRAGMA journal_mode=WAL");
    await compare("wal-mode","stopped",2);
  });
  it("bounds the inventory before comparing rows",async () => {
    const result=await exec(python,["-B","-c",`import importlib.util,sys
from pathlib import Path
sys.path.insert(0,'scripts')
spec=importlib.util.spec_from_file_location('checker','scripts/check-restore-stops.py')
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
assert module.MAX_ROWS == 10000
module.MAX_ROWS=0
try:
    module.stops(Path(sys.argv[1]),'t')
except ValueError as error:
    assert str(error) == 'inventory limit'
else:
    raise AssertionError('overflow accepted')
`,file("stopped")]);
    expect(result.stdout).toBe(""); expect(result.stderr).toBe("");
  });
  it("requires explicit tenant scope",async () => {
    await expect(exec(python,["-B","scripts/check-restore-stops.py","--restored",file("stopped"),
      "--reference",file("unstopped")])).rejects.toMatchObject({code:2,stdout:""});
  });
});
