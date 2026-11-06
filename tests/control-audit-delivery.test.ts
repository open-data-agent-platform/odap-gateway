import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { deliverNextControlEvent as deliver } from "../lib/control-audit-delivery";
import { persistControlObject } from "../lib/control-storage";
import { jobDatabase, jobSqlite } from "./fixtures/job-sqlite";

const exec = promisify(execFile);
let dir: string, source: string, baseline: string, sink: string;
const a = { db:jobDatabase(() => source), tenantId:"a", principalId:"owner" };
const b = { ...a,tenantId:"b" };
const sql = (q: string, p: string[] = []) => jobSqlite(source,"run",q,p);
const first = (q: string, p: string[] = []) => jobSqlite(source,"readonly-first",q,p);
const cursor = () => first("SELECT CAST(sequence AS TEXT) seq FROM control_audit_checkpoints WHERE tenant_id='a' AND consumer_id='archive'");
const receipt = (who: typeof a, id: string) => persistControlObject(who,"receipt",{schemaVersion:"0.1",tenantId:who.tenantId,
  id,intentId:"synthetic-attempt",contractId:null,semanticReleaseId:null,outcome:"denied",reason:"Missing release",recordedAt:"2026-01-01T00:00:00.000Z"});
const accept: Parameters<typeof deliver>[2] = async event => event;
const consume = (mode: string) => exec(process.execPath,[join(dir,"tests/fixtures/control-audit-consumer.js"),source,sink,mode]);
async function newSink(name: string) {
  sink = join(dir,name);
  await jobSqlite(sink,"run",`CREATE TABLE accepted(tenant TEXT,consumer TEXT,seq TEXT,payload TEXT,attempts INTEGER,
    PRIMARY KEY(tenant,consumer,seq))`);
}
async function checkPrefix(expectedExit: number, restored = source, retained = sink, tenant = "a", consumer = "archive") {
  const python = process.env.ODAP_TEST_PYTHON || (process.platform === "win32" ? "python" : "python3");
  const args = ["-B","scripts/check-restore-audit-prefix.py","--restored",restored,"--sink",retained,"--tenant",tenant,"--consumer",consumer];
  const result = await exec(python,args).then(r => ({...r,code:0}), (e: {code:number;stdout:string;stderr:string}) => e);
  expect(result.code).toBe(expectedExit);
  if (expectedExit === 2) {
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("No comparison: unusable snapshots, scope, checkpoint or event.");
    return;
  }
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout);
}

describe("tenant audit stream checkpoint", () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(),"odap-audit-cursor-"));
    source = baseline = join(dir,"baseline.db");
    await jobSqlite(source,"setup-v30");
    await sql("INSERT INTO control_tenants VALUES ('a','A'),('b','B')");
    await sql("INSERT INTO control_memberships VALUES ('a','owner','owner',1),('a','reader','reader',1),('b','owner','owner',1)");
    await receipt(a,"one"); await receipt(b,"peer"); await receipt(a,"two");
    await jobSqlite(source,"apply-audit-checkpoints");
    await exec(process.execPath,[require.resolve("typescript/bin/tsc"),"--noCheck","--module","commonjs","--target","es2022",
      "--rootDir",".","--outDir",dir,"tests/fixtures/control-audit-consumer.ts"]);
  },30000);
  beforeEach(async () => { source = join(dir,"source.db"); await copyFile(baseline,source); });
  afterAll(async () => { if (dir) await rm(dir,{recursive:true,force:true}); });

  it("replays after process death between durable sink commit and source acknowledgment", async () => {
    await newSink("sink.db");
    await expect(consume("crash")).rejects.toMatchObject({code:73});
    expect(await cursor()).toBeNull();
    const saved = () => jobSqlite(sink,"readonly-first","SELECT seq,payload,attempts FROM accepted WHERE json_extract(payload,'$.objectId')='one'");
    const crash = await saved();
    expect(crash.attempts).toBe(1);
    expect(JSON.parse(crash.payload)).toMatchObject({tenantId:"a",objectKind:"receipt",objectId:"one",actor:"owner"});
    expect((await consume("restart")).stdout).toBe("acknowledged");
    expect(await cursor()).toEqual({seq:crash.seq});
    expect(await saved()).toEqual({...crash,attempts:2});
    expect((await consume("restart")).stdout).toBe("acknowledged");
    expect((await consume("restart")).stdout).toBe("idle");
    expect(await jobSqlite(sink,"readonly-first",`SELECT count(*) n,sum(attempts) attempts,
      sum(tenant!='a' OR json_extract(payload,'$.objectId') NOT IN ('one','two')) leaks FROM accepted`))
      .toEqual({n:2,attempts:3,leaks:0});
    await receipt(a,"three");
    expect((await consume("restart")).stdout).toBe("acknowledged");
  },20000);

  it("finds prefix loss and content drift even when count and largest accepted sequence agree", async () => {
    await newSink("retained.db");
    await sql("INSERT INTO control_object_events(sequence,tenant_id,object_kind,object_id,actor) VALUES (9007199254740993,'a','fixture','high','owner')");
    for (let i=0;i<3;i++) expect((await consume("restart")).stdout).toBe("acknowledged");
    const restored = join(dir,"restored.db");
    await copyFile(source,restored);
    expect(await cursor()).toEqual({seq:"9007199254740993"});
    expect(await checkPrefix(0,restored)).toEqual({acknowledgedPrefix:"equal",matching:3,missingAtSink:0,
      unexpectedAtSink:0,changed:0,sinkBeyondCheckpoint:0,resumeAuthorized:false});
    const mutate = (q: string, p: string[] = []) => jobSqlite(sink,"run",q,p);
    const seqOf = async (id: string) => (await first("SELECT CAST(sequence AS TEXT) seq FROM control_object_events WHERE object_id=?",[id])).seq;
    const middle = await seqOf("two"), peer = await seqOf("peer");
    // Identical keys retained for a different tenant or consumer cannot cover the gap.
    await mutate("INSERT INTO accepted SELECT 'b',consumer,seq,payload,1 FROM accepted WHERE seq=?",[middle]);
    await mutate("UPDATE accepted SET consumer='other' WHERE tenant='a' AND seq=?",[middle]);
    expect(await checkPrefix(1,restored)).toMatchObject({matching:2,missingAtSink:1,unexpectedAtSink:0});
    await mutate("INSERT INTO accepted SELECT 'a','archive',?,json_set(payload,'$.sequence',?),1 FROM accepted WHERE tenant='b' AND seq=?",[peer,peer,middle]);
    await mutate("UPDATE accepted SET payload=json_set(payload,'$.actor','altered') WHERE seq='9007199254740993'");
    const fingerprint = async () => ({
      files: (await readdir(dir)).sort(),
      source: createHash("sha256").update(await readFile(restored)).digest("hex"),
      sink: createHash("sha256").update(await readFile(sink)).digest("hex")
    });
    const before = await fingerprint();
    expect(await checkPrefix(1,restored)).toEqual({acknowledgedPrefix:"different",matching:1,missingAtSink:1,
      unexpectedAtSink:1,changed:1,sinkBeyondCheckpoint:0,resumeAuthorized:false});
    expect(await fingerprint()).toEqual(before);
  },30000);

  it("separates an unacknowledged sink commit from the prefix and fails closed on unusable inputs", async () => {
    await newSink("ahead.db");
    await checkPrefix(2); // No checkpoint yet is not a successful comparison.
    expect((await consume("restart")).stdout).toBe("acknowledged");
    await expect(consume("crash")).rejects.toMatchObject({code:73});
    expect(await checkPrefix(0)).toMatchObject({matching:1,sinkBeyondCheckpoint:1,resumeAuthorized:false});
    await checkPrefix(2,source,source);
    await checkPrefix(2,source,baseline);
    await checkPrefix(2,source,sink,"a","other");
    await checkPrefix(2,source,sink,"b","archive");
    const detached = join(dir,"sidecar.db");
    await copyFile(source,detached);
    expect(await checkPrefix(0,detached,sink)).toMatchObject({matching:1});
    await writeFile(detached+"-wal","synthetic",{flag:"wx"});
    await checkPrefix(2,detached,sink);
    await jobSqlite(sink,"run","UPDATE accepted SET seq='9223372036854775808' WHERE json_extract(payload,'$.objectId')='two'");
    await checkPrefix(2);
  },20000);

  it("isolates consumers and tenants and never checkpoints a failed or mismatched acceptance", async () => {
    await expect(deliver(a,"archive",async () => { throw new Error("Sink refused"); })).rejects.toThrow("Sink refused");
    for (const drift of [{tenantId:"b"},{consumerId:"other"},{sequence:"0"}])
      await expect(deliver(a,"archive",async e => ({...e,...drift}))).rejects.toThrow("not confirmed");
    expect(await cursor()).toBeNull();
    const received: string[] = [];
    const collect: typeof accept = async e => { received.push(e.tenantId+":"+e.objectId); return e; };
    for (const [who,id] of [[a,"archive"],[a,"other"],[b,"archive"]] as const)
      expect(await deliver(who,id,collect)).toBe("acknowledged");
    expect(received).toEqual(["a:one","a:one","b:peer"]);
    const never = vi.fn(accept);
    await expect(deliver({...a,principalId:"reader"},"archive",never)).rejects.toThrow("unavailable");
    await expect(deliver({...a,tenantId:"outside"},"archive",never)).rejects.toThrow("unavailable");
    expect(never).not.toHaveBeenCalled();
  });

  it("rechecks ownership on acknowledgment and does not let a slow consumer rewind a newer cursor", async () => {
    await expect(deliver(a,"archive",async e => {
      await sql("UPDATE control_memberships SET active=0 WHERE tenant_id='a' AND principal_id='owner'");
      return e;
    })).rejects.toThrow("inactive audit owner");
    expect(await cursor()).toBeNull();
    await sql("UPDATE control_memberships SET active=1 WHERE tenant_id='a' AND principal_id='owner'");
    await receipt(a,"three");
    const race: typeof accept = async e => {
      expect(await deliver(a,"archive",accept)).toBe("acknowledged");
      return e;
    };
    expect(await deliver(a,"archive",race)).toBe("cursor_changed");
    expect(await deliver(a,"archive",async e => {
      await race(e); await deliver(a,"archive",accept); return e;
    })).toBe("cursor_changed");
    expect(await deliver(a,"archive",accept)).toBe("idle");
    expect(await cursor()).toEqual(await first("SELECT CAST(sequence AS TEXT) seq FROM control_object_events WHERE tenant_id='a' AND object_id='three'"));
  },10000);

  it("prevents direct skips, rewinds, replacement or deletion and preserves 64-bit sequence keys", async () => {
    const start = "INSERT INTO control_audit_checkpoints(tenant_id,consumer_id,sequence,acknowledged_by)";
    const one = (await first("SELECT CAST(MIN(sequence) AS TEXT) seq FROM control_object_events WHERE tenant_id='a'")).seq;
    await expect(sql(start+" SELECT 'a','archive',MAX(sequence),'owner' FROM control_object_events WHERE tenant_id='a'")).rejects.toThrow("invalid initial");
    await deliver(a,"archive",accept);
    const before = await cursor();
    await expect(deliver(a,"archive",async e => {
      await sql("UPDATE control_memberships SET role='reader' WHERE tenant_id='a' AND principal_id='owner'");
      return e;
    })).rejects.toThrow("inactive audit owner");
    expect(await cursor()).toEqual(before);
    await sql("UPDATE control_memberships SET role='owner' WHERE tenant_id='a' AND principal_id='owner'");
    await sql("INSERT INTO control_object_events(sequence,tenant_id,object_kind,object_id,actor) VALUES (9007199254740993,'a','fixture','high','owner')");
    await expect(sql("UPDATE control_audit_checkpoints SET sequence=9007199254740993")).rejects.toThrow("invalid next");
    await deliver(a,"archive",accept);
    expect(await deliver(a,"archive",async e => { expect(e.sequence).toBe("9007199254740993"); return e; })).toBe("acknowledged");
    await expect(sql("UPDATE control_audit_checkpoints SET sequence=?",[one])).rejects.toThrow("invalid next");
    await expect(sql("INSERT OR REPLACE INTO control_audit_checkpoints VALUES ('a','archive',?,'owner')",[one])).rejects.toThrow("invalid initial");
    await expect(sql("DELETE FROM control_audit_checkpoints")).rejects.toThrow("cannot discard");
    expect(await cursor()).toEqual({seq:"9007199254740993"});
  },10000);
});
