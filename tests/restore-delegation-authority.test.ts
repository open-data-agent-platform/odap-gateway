import { execFile } from "node:child_process";
import { copyFile, link, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { proveDelegation } from "../lib/agent-delegations";
import { delegationFixture } from "./fixtures/delegation";
import { jobDatabase, jobSqlite } from "./fixtures/job-sqlite";

const exec=promisify(execFile),python=process.env.ODAP_TEST_PYTHON||(process.platform==="win32"?"python":"python3");
let dir: string, id: string, signature: string, alternate: string;
const file=(name: string)=>join(dir,name+".sqlite");
const sql=(name: string,query: string,params: string[]=[])=>jobSqlite(file(name),"run",query,params);
const prove=(name: string)=>proveDelegation(jobDatabase(()=>file(name)),"test-gateway","t",id,signature);
async function compare(restored: string,reference: string,code=0,tenant="t") {
  const result=await exec(python,["-B","scripts/check-restore-delegations.py","--restored",file(restored),
    "--reference",file(reference),"--tenant",tenant]).then(r=>({...r,code:0}),
    (e:{code:number;stdout:string;stderr:string})=>e);
  expect(result.code).toBe(code);
  if(code===2){
    expect(result.stdout).toBe("");
    expect(result.stderr.replace(/\r\n/g,"\n")).toBe("No comparison: unusable standalone snapshots, tenant or delegation bindings.\n");
    return null;
  }
  expect(result.stderr).toBe("");expect(result.stdout).not.toContain(id);
  expect(result.stdout).not.toMatch(/google:|reporter|test-gateway|sha256:|public_hex|SELECT |\.sqlite|[0-9a-f]{64}/);
  return JSON.parse(result.stdout);
}
async function corrupt(name: string,queries: string[],source="proven") {
  await copyFile(file(source),file(name));
  await exec(python,["-B","-c",`import json,sqlite3,sys
with sqlite3.connect(sys.argv[1]) as db:
    db.execute('PRAGMA ignore_check_constraints=ON')
    for query in json.loads(sys.argv[2]):
        db.execute(query)
`,file(name),JSON.stringify(queries)]);
}
const keyUpdate="DROP TRIGGER agent_key_disable_only",delegationUpdate="DROP TRIGGER delegation_revoke_only";
const grantUpdate="DROP TRIGGER human_grant_no_update",requestUpdate="DROP TRIGGER contract_request_no_update";
const proofUpdate="DROP TRIGGER delegation_proof_no_update";

describe("offline delegated authority restore comparison",{timeout:25000},()=>{
  beforeAll(async()=>{
    vi.spyOn(globalThis,"fetch").mockRejectedValue(new Error("No network in restore comparison"));
    dir=await mkdtemp(join(tmpdir(),"odap-delegation-restore-"));
    const pair=await crypto.subtle.generateKey({name:"ECDSA",namedCurve:"P-256"},false,["sign","verify"]);
    const f=delegationFixture(()=>file("live"),()=>pair);
    await jobSqlite(file("live"),"setup-v19");await f.setupGrant("t");
    await sql("live","INSERT INTO control_tenants VALUES('peer','Peer')");
    await sql("live","VACUUM INTO ?",[file("pre20")]);
    await f.migrateAndEnroll();
    await sql("live","VACUUM INTO ?",[file("enrolled")]);
    const challenge=await f.challenge();id=challenge.delegationId;signature=await f.sign(challenge.challenge);
    alternate=f.hex(await crypto.subtle.exportKey("raw",(await f.keys()).publicKey));
    await sql("live","VACUUM INTO ?",[file("unused")]);
    expect(await prove("live")).toMatchObject({delegationId:id});
    await sql("live","VACUUM INTO ?",[file("proven")]);
    for(const name of ["revoked-unused","disabled-unused"])await copyFile(file("unused"),file(name));
    await sql("revoked-unused","UPDATE agent_delegations SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')");
    await sql("disabled-unused","UPDATE agent_verification_keys SET active=0");
    expect((await f.revoke(id)).status).toBe(200);
    await sql("live","UPDATE agent_verification_keys SET active=0");
    await sql("live","VACUUM INTO ?",[file("withdrawn")]);
    await sql("live",`INSERT INTO dispatch_retired_releases(tenant_id,release_id,reason,retired_by,retired_at)
      VALUES('t','released','retired','google:owner',strftime('%Y-%m-%dT%H:%M:%fZ','now'))`);
    await sql("live","UPDATE control_memberships SET active=0 WHERE tenant_id='t'");
    await sql("live","DELETE FROM dispatch_read_grants WHERE tenant_id='t'");
    await sql("live","VACUUM INTO ?",[file("ineligible")]);
  },90000);
  afterAll(async()=>{
    expect(globalThis.fetch).not.toHaveBeenCalled();vi.restoreAllMocks();
    if(dir)await rm(dir,{recursive:true,force:true});
  });
  it("compares retained history without changing bytes or creating sidecars",async()=>{
    await copyFile(file("withdrawn"),file("restored"));
    const paths=[file("withdrawn"),file("restored")],before=await Promise.all(paths.map(p=>readFile(p))),names=await readdir(dir);
    const report=await compare("restored","withdrawn");
    expect(report).toMatchObject({delegationComparison:"equal",scope:"recorded-tenant-delegation-history-only",
      restored:{keys:1,requests:1,grants:1,delegations:1,proofs:1,disabledKeys:1,revokedDelegations:1},
      issuerAuthenticated:false,signatureVerified:false,executionAuthorized:false,retryAuthorized:false,servingAuthorized:false});
    expect(report.restored).toEqual(report.reference);
    expect(Object.values(report.differences)).toEqual(Array(5).fill({referenceOnly:0,restoredOnly:0,changed:0}));
    for(let i=0;i<paths.length;i++)expect((await readFile(paths[i])).equals(before[i])).toBe(true);
    expect(await readdir(dir)).toEqual(names);
  });
  it.each(["revoked-unused","disabled-unused","proven"])("detects stale proof acceptance hidden by matching memberships: %s",async current=>{
    const result=await exec(python,["-B","scripts/check-restore-memberships.py","--restored",file("unused"),"--reference",file(current)]);
    expect(JSON.parse(result.stdout).membershipComparison).toBe("equal");
    await copyFile(file("unused"),file("stale-"+current));
    await copyFile(file(current),file("current-"+current));
    expect(await prove("current-"+current)).toBeNull();
    expect(await prove("stale-"+current)).toMatchObject({delegationId:id});
    const report=await compare("unused",current,1);
    const category=current==="proven"?"proofs":current==="disabled-unused"?"keys":"delegations";
    expect(report.differences[category]).toMatchObject(current==="proven"?{referenceOnly:1,changed:0}:{referenceOnly:0,changed:1});
    expect(report.executionAuthorized).toBe(false);
  });
  it("retains revoked, disabled and proven records despite later membership/policy/release withdrawal",async()=>{
    expect(await compare("withdrawn","ineligible")).toMatchObject({delegationComparison:"equal",restored:{proofs:1,revokedDelegations:1,disabledKeys:1}});
    expect(await jobSqlite(file("ineligible"),"readonly-first","SELECT count(*) AS n FROM current_agent_delegations")).toEqual({n:0});
  });
  it("reports new and removed records and equally old empty tenant histories without authority",async()=>{
    expect(await compare("enrolled","unused",1)).toMatchObject({differences:{delegations:{referenceOnly:1}}});
    expect(await compare("proven","unused",1)).toMatchObject({differences:{proofs:{restoredOnly:1}}});
    expect(await compare("unused","withdrawn",0,"peer")).toMatchObject({restored:{keys:0,grants:0,delegations:0,proofs:0},
      reference:{keys:0,grants:0,delegations:0,proofs:0},servingAuthorized:false});
  });
  it("includes an unused enrolled public key without reading private signing material",async()=>{
    await copyFile(file("enrolled"),file("extra-key"));
    await sql("extra-key","INSERT INTO agent_verification_keys VALUES('t','reporter','k2',?,1)",[alternate]);
    expect(await compare("enrolled","extra-key",1)).toMatchObject({differences:{keys:{referenceOnly:1}},reference:{keys:2,delegations:0}});
  });
  it.each([
    ["audience","delegations",[delegationUpdate,"UPDATE agent_delegations SET audience='changed'"]],
    ["grant-policy","grants",[grantUpdate,"UPDATE contract_human_grants SET policy_revision='p2'"]],
    ["grant-owner","grants",[grantUpdate,"UPDATE contract_human_grants SET granted_by='google:replacement'"]],
    ["grant-project","grants",[grantUpdate,"UPDATE contract_human_grants SET project_id='other-project'"]],
    ["grant-location","grants",[grantUpdate,"UPDATE contract_human_grants SET location='EU'"]],
    ["grant-expiry","grants",[grantUpdate,"UPDATE contract_human_grants SET expires_at='2099-01-01T00:00:00.000Z'"]],
    ["request-action","requests",[requestUpdate,`UPDATE contract_requests SET action_digest='sha256:${"a".repeat(64)}'`]],
    ["request-release","requests",[requestUpdate,"UPDATE contract_requests SET release_id='replacement'"]],
  ])("detects changed %s despite equal row counts",async(name,category,queries)=>{
    await corrupt(name as string,queries as string[]);
    expect((await compare(name as string,"proven",1)).differences[category as string]).toEqual({changed:1,referenceOnly:0,restoredOnly:0});
  });
  it("detects replacement public verification material with the same key identity",async()=>{
    await corrupt("key-material",[keyUpdate,`UPDATE agent_verification_keys SET public_hex='${alternate}'`]);
    expect(await compare("key-material","proven",1)).toMatchObject({differences:{keys:{changed:1}},signatureVerified:false});
  });
  it.each([
    ["invalid-key-state",[keyUpdate,"UPDATE agent_verification_keys SET active=2"]],
    ["malformed-public-point",[keyUpdate,"UPDATE agent_verification_keys SET public_hex='invalid'"]],
    ["orphan-key",["DROP TRIGGER agent_key_no_delete","DELETE FROM agent_verification_keys"]],
    ["orphan-grant",["DROP TRIGGER human_grant_no_delete","DELETE FROM contract_human_grants"]],
    ["orphan-request",["DROP TRIGGER contract_request_no_delete","DELETE FROM contract_requests"]],
    ["orphan-proof",["DROP TRIGGER delegation_no_delete","DELETE FROM agent_delegations"]],
    ["wrong-agent",[delegationUpdate,"UPDATE agent_delegations SET agent_id='other-agent'"]],
    ["blank-audience",[delegationUpdate,"UPDATE agent_delegations SET audience=' '"]],
    ["control-audience",[delegationUpdate,"UPDATE agent_delegations SET audience=char(10)"]],
    ["self-grant",[grantUpdate,"UPDATE contract_human_grants SET granted_by=requester_id"]],
    ["invalid-action",[requestUpdate,"UPDATE contract_requests SET action_digest='wrong'"]],
    ["grant-before-request",[grantUpdate,"UPDATE contract_human_grants SET granted_at='2000-01-01T00:00:00.000Z'"]],
    ["invalid-expiry",[grantUpdate,"UPDATE contract_human_grants SET expires_at=granted_at"]],
    ["invalid-revocation-date",[delegationUpdate,"UPDATE agent_delegations SET revoked_at='2026-02-30T00:00:00.000Z'"]],
    ["early-revocation",[delegationUpdate,"UPDATE agent_delegations SET revoked_at='2000-01-01T00:00:00.000Z'"]],
    ["proof-before-grant",[proofUpdate,"UPDATE agent_delegation_proofs SET verified_at='2000-01-01T00:00:00.000Z'"]],
    ["proof-after-expiry",[proofUpdate,"UPDATE agent_delegation_proofs SET verified_at='2099-01-01T00:00:00.000Z'"]],
    ["case-folded-key",[keyUpdate,"UPDATE agent_verification_keys SET agent_id=upper(agent_id)"]],
    ["case-folded-grant",[grantUpdate,"UPDATE contract_human_grants SET id=upper(id)"]],
    ["case-folded-requester",[requestUpdate,"UPDATE contract_requests SET principal_id=upper(principal_id)"]],
    ["duplicate-delegation",["ALTER TABLE agent_delegations RENAME TO retained_delegations",
      "CREATE TABLE agent_delegations AS SELECT * FROM retained_delegations UNION ALL SELECT * FROM retained_delegations"]],
  ])("rejects %s with no partial report or identifier disclosure",async(name,queries)=>{
    await corrupt(name as string,queries as string[]);await compare(name as string,"proven",2);
  });
  it("rejects a proof dated after recorded revocation",async()=>{
    await corrupt("late-proof",[proofUpdate,"UPDATE agent_delegation_proofs SET verified_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 second')"],"withdrawn");
    await compare("late-proof","withdrawn",2);
  });
  it("ignores unrelated tenant damage but rejects its explicitly selected orphan records",async()=>{
    await corrupt("peer-damage",["INSERT INTO agent_delegation_proofs SELECT 'peer',delegation_id,verified_at FROM agent_delegation_proofs"]);
    expect(await compare("proven","peer-damage")).toMatchObject({delegationComparison:"equal"});
    await compare("proven","peer-damage",2,"peer");
    for(const tenant of ["T","missing","t' OR 1=1 --"," "])await compare("proven","peer-damage",2,tenant);
  });
  it("rejects missing columns and views even for an empty selected tenant",async()=>{
    await corrupt("missing-column",["ALTER TABLE agent_delegations RENAME COLUMN revoked_at TO removed"]);
    await compare("missing-column","proven",2,"peer");
    await corrupt("view",["ALTER TABLE agent_delegation_proofs RENAME TO retained_proofs","CREATE VIEW agent_delegation_proofs AS SELECT * FROM retained_proofs"]);
    await compare("view","proven",2,"peer");
  });
  it("rejects old-schema, same, linked, missing and journal-dependent files",async()=>{
    await compare("pre20","proven",2);await compare("proven","proven",2);
    await link(file("proven"),file("hard-link"));await compare("hard-link","proven",2);
    await compare("missing","proven",2);expect(await readdir(dir)).not.toContain("missing.sqlite");
    for(const suffix of ["-wal","-shm","-journal"]){
      const name="sidecar"+suffix;await copyFile(file("proven"),file(name));
      await writeFile(file(name)+suffix,"synthetic journal");await compare(name,"proven",2);
    }
    await copyFile(file("proven"),file("wal-mode"));await jobSqlite(file("wal-mode"),"first","PRAGMA journal_mode=WAL");
    await compare("wal-mode","proven",2);
  });
  it("bounds each inventory before validation",async()=>{
    const result=await exec(python,["-B","-c",`import importlib.util,sys
from pathlib import Path
sys.path.insert(0,'scripts')
spec=importlib.util.spec_from_file_location('checker','scripts/check-restore-delegations.py')
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
assert module.MAX_ROWS == 10000
module.MAX_ROWS=0
try:
    module.snapshot(Path(sys.argv[1]),'t')
except ValueError as error:
    assert str(error) == 'inventory limit'
else:
    raise AssertionError('overflow accepted')
`,file("proven")]);
    expect(result.stdout).toBe("");expect(result.stderr).toBe("");
  });
  it("requires an explicit tenant",async()=>{
    await expect(exec(python,["-B","scripts/check-restore-delegations.py","--restored",file("proven"),
      "--reference",file("unused")])).rejects.toMatchObject({code:2,stdout:""});
  });
});
