import { execFile } from "node:child_process";
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SESSION_COOKIE, signAuthPayload } from "../lib/auth";
import worker from "../worker";
import { jobDatabase, jobSqlite } from "./fixtures/job-sqlite";

const exec = promisify(execFile);
const compare = (restored: string, reference: string) => exec(process.env.ODAP_TEST_PYTHON ||
  (process.platform === "win32" ? "python" : "python3"),
  ["scripts/check-restore-memberships.py","--restored",restored,"--reference",reference]);
const secret = "restore-member-test-only";
let dir: string, restored: string, reference: string, cookie: string;

async function difference(stale: string, current: string) {
  try {
    await compare(stale,current);
  } catch (err) {
    expect(err).toMatchObject({code:1,stderr:""});
    return JSON.parse((err as { stdout: string }).stdout);
  }
  throw new Error("Expected the membership comparison to report a difference");
}

async function readReceipt(file: string) {
  return worker.fetch(new Request("https://gateway.test/api/control/t/receipt/denial?view=summary",
    { headers:{Cookie:cookie} }), { DB:jobDatabase(()=>file,"readonly"),AUTH_COOKIE_SECRET:secret,
    ASSETS:{fetch:async()=>{ throw new Error("Unexpected asset access"); }} }, { waitUntil:()=>undefined });
}

describe("offline membership comparison after a restore", () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(),"odap-restore-membership-"));
    const source = join(dir,"source.sqlite");
    restored = join(dir,"restored.sqlite");
    reference = join(dir,"reference.sqlite");
    await jobSqlite(source,"setup");
    await jobSqlite(source,"run","INSERT INTO control_tenants VALUES('peer','Peer')");
    await jobSqlite(source,"run",`INSERT INTO control_memberships VALUES
      ('t','google:fixture','reader',1),('peer','google:fixture','owner',1)`);
    const payload = {schemaVersion:"0.1",tenantId:"t",id:"denial",intentId:"private-attempt",contractId:null,
      semanticReleaseId:null,outcome:"denied",reason:"fixture-only",recordedAt:"2026-01-01T00:00:00.000Z"};
    await jobSqlite(source,"run",`INSERT INTO evidence_receipts(tenant_id,id,payload,created_by)
      VALUES('t','denial',?,'owner')`,[JSON.stringify(payload)]);
    await jobSqlite(source,"run","VACUUM INTO ?",[restored]);
    await jobSqlite(source,"run","UPDATE control_memberships SET active=0 WHERE tenant_id='t' AND principal_id='google:fixture'");
    await jobSqlite(source,"run","VACUUM INTO ?",[reference]);
    cookie = SESSION_COOKIE+"="+await signAuthPayload({provider:"google",providerId:"fixture",email:"fixture@example.test",
      name:"Fixture",expiresAt:Date.now()+600000},secret);
  },30000);
  afterAll(async () => { if (dir) await rm(dir,{recursive:true,force:true}); });

  it("reproduces a stale receipt read and identifies the extra grant without disclosing its holder", async () => {
    const before = await Promise.all([readFile(restored),readFile(reference)]);
    const q = "SELECT payload FROM evidence_receipts WHERE tenant_id='t' AND id='denial'";
    expect(await jobSqlite(restored,"readonly-first",q)).toEqual(await jobSqlite(reference,"readonly-first",q));
    const denied = await readReceipt(reference);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ok:false,code:"tenant_access_denied"});
    const stale = await readReceipt(restored);
    expect(stale.status).toBe(200);
    expect(await stale.json()).toMatchObject({ok:true,summary:{id:"denial",outcome:"denied"}});
    expect(await difference(restored,reference)).toEqual({membershipComparison:"different",
      restoredOnly:1,referenceOnly:0,differentRole:0,servingAuthorized:false});
    expect((await readFile(restored)).equals(before[0])).toBe(true);
    expect((await readFile(reference)).equals(before[1])).toBe(true);
  });

  it("distinguishes changed roles and new grants; equal inputs do not authorize serving", async () => {
    const copy = join(dir,"membership-changes.sqlite");
    await copyFile(reference,copy);
    expect(JSON.parse((await compare(copy,reference)).stdout)).toEqual({membershipComparison:"equal",
      restoredOnly:0,referenceOnly:0,differentRole:0,servingAuthorized:false});
    await jobSqlite(copy,"run","UPDATE control_memberships SET role='reader' WHERE tenant_id='peer' AND principal_id='google:fixture'");
    await jobSqlite(copy,"run","INSERT INTO control_memberships VALUES('t','added','reviewer',1)");
    expect(await difference(reference,copy)).toEqual({membershipComparison:"different",
      restoredOnly:0,referenceOnly:1,differentRole:1,servingAuthorized:false});
  });

  it("rejects missing, same-file, journal-dependent and malformed inputs without a comparison", async () => {
    const missing = join(dir,"missing.sqlite"), dirty = join(dir,"dirty.sqlite"), bad = join(dir,"bad.sqlite");
    await copyFile(reference,dirty);
    await writeFile(dirty+"-wal","fixture journal marker");
    await jobSqlite(bad,"run","CREATE TABLE control_memberships(tenant_id,principal_id,role,active)");
    await jobSqlite(bad,"run","INSERT INTO control_memberships VALUES('t','duplicate','reader',0),('t','duplicate','reader',1)");
    const wal = join(dir,"wal-mode.sqlite");
    await copyFile(reference,wal);
    expect(await jobSqlite(wal,"first","PRAGMA journal_mode=WAL")).toEqual({journal_mode:"wal"});
    for (const pair of [[restored,restored],[restored,missing],[dirty,reference],[restored,bad],[wal,reference]])
      await expect(compare(pair[0],pair[1])).rejects.toMatchObject({code:2,stdout:""});
    expect(await readdir(dir)).not.toContain("missing.sqlite");
  });
});
