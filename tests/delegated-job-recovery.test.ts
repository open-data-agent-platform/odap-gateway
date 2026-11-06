import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { handoffDelegatedRead } from "../lib/delegated-handoff";
import { observeDelegatedClaim, readDelegatedRecovery } from "../lib/delegated-job-recovery";
import { delegationFixture } from "./fixtures/delegation";
import { jobSqlite } from "./fixtures/job-sqlite";
import { corruptTerminalEnrichment } from "./fixtures/conflicting-terminal";

let dir: string, file: string, claimed: string, prepared: string, enrolled: CryptoKeyPair;
let intentId: string, delegationId: string, receiptId: string, tag: string, cap: string;
let ref: { jobId: string; projectId: string; location: string };
const { db, first, sql, keys, seedAmbiguousDelegation, revoke } = delegationFixture(() => file, () => enrolled);
const owner = { db, tenantId: "t", principalId: "google:operator" }, audience = "test-gateway";
const subject = { audience, principalId: "google:reader", agentId: "reporter" };
const action = { target: "orders", metricId: "revenue", parameters: { year: 2026 } };
const missing = () => new Response(null,{ status: 404 });
const resource = (state = "DONE", bytes?: string, reason?: string) => ({
  jobReference: { ...ref }, configuration: { jobType: "QUERY", labels: { odap_action: tag }, query: { maximumBytesBilled: cap } },
  status: { state, ...(reason && { errorResult: { reason } }) }, statistics: { query: { totalBytesBilled: bytes } }
});
const observe = (lookup: Parameters<typeof observeDelegatedClaim>[3]) => observeDelegatedClaim(owner,audience,intentId,lookup);
const stored = () => readDelegatedRecovery(owner,audience,intentId);
const rows = () => first("SELECT count(*) n FROM bigquery_terminal_observations").then(r=>r.n);
const ledger = () => first(`SELECT (SELECT count(*) FROM dispatch_claims) claims,(SELECT count(*) FROM cost_settlements) settlements,
  (SELECT reserved_units FROM control_budgets WHERE tenant_id='t' AND id='b') reserved,
  (SELECT count(*) FROM evidence_receipts) receipts, (SELECT json_extract(payload,'$.outcome') FROM evidence_receipts) receiptState`);
const upgrade = () => jobSqlite(file,"apply-delegated-observations");

describe("observation-only delegated recovery", { timeout: 25000 }, () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(),"odap-observation-"));
    file = claimed = join(dir,"ambiguous-v24.db");
    prepared = join(dir,"prepared-v24.db");
    enrolled = await keys();
    ({ intentId,delegationId,receiptId,ref,tag,cap } = await seedAmbiguousDelegation(()=>copyFile(file,prepared)));
  },30000);
  beforeEach(async () => {
    file = join(dir,crypto.randomUUID()+".db");
    await copyFile(claimed,file);
    await upgrade();
  });
  afterAll(async () => { if (dir) await rm(dir,{ recursive: true,force: true }); });

  it.each(["before", "during-404", "during-DONE"])("rejects contradictory restored outcomes: %s", async phase => {
    const before = await ledger();
    await observe(async () => Response.json(resource()));
    const corrupt = () => corruptTerminalEnrichment(sql, intentId);
    if (phase === "before") await corrupt();
    const lookup = vi.fn(async () => {
      if (phase !== "before") await corrupt();
      return phase === "during-DONE" ? Response.json(resource("DONE","0","invalidQuery")) : missing();
    });
    await expect(observe(lookup)).rejects.toThrow("Conflicting terminal outcomes");
    expect(lookup).toHaveBeenCalledTimes(phase === "before" ? 0 : 1);
    await expect(stored()).rejects.toThrow("Conflicting terminal outcomes");
    await expect(readDelegatedRecovery(owner,"other",intentId)).rejects.toThrow("claim unavailable");
    expect(await rows()).toBe(2);
    expect(await ledger()).toEqual(before);
  });

  it("observes the original claim after withdrawal, preserves uncertainty and never retries or settles", async () => {
    const before = await ledger();
    expect(before).toMatchObject({ claims: 1, settlements: 0, reserved: 100, receiptState: "pending" });
    expect((await revoke(delegationId)).status).toBe(200);
    const lookup = vi.fn().mockResolvedValueOnce(missing()).mockResolvedValueOnce(Response.json(resource("RUNNING")))
      .mockResolvedValueOnce(Response.json(resource("DONE","9007199254740992")))
      .mockResolvedValueOnce(Response.json(resource("DONE","0"))).mockResolvedValueOnce(missing());
    expect((await observe(lookup)).observation).toEqual({ state: "not-found" });
    expect((await observe(lookup)).observation).toEqual({ state: "pending" });
    expect(await stored()).toEqual({ jobReference: ref,receiptId,observation: null });
    expect((await observe(lookup)).observation).toMatchObject({ state: "succeeded",billedBytes: null });
    const final = await observe(lookup);
    expect(final.observation).toMatchObject({ state: "succeeded",billedBytes: 0,observedBy: owner.principalId });
    expect(await observe(lookup)).toEqual(final);
    expect(await stored()).toEqual(final);
    expect(lookup.mock.calls).toEqual(Array.from({length:5},()=>[ref]));
    const send = vi.fn();
    await expect(handoffDelegatedRead(owner,intentId,subject,action,send)).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
    expect(await rows()).toBe(2);
    expect(await ledger()).toEqual(before);
  });

  it("rejects substituted identity, label, ceiling, dry run, malformed terminal status and lookup errors", async () => {
    const good = resource();
    for (const substitute of [{ jobId: "other" },{ location: "EU" },{ projectId: "other" }])
      await expect(observe(async()=>Response.json({ ...good,jobReference: { ...ref,...substitute } }))).rejects.toThrow("Unmatched");
    for (const substitute of [{ labels: { odap_action: "other" } },{ query: {} },{ query: { maximumBytesBilled: "99999999" } },
      { dryRun: true },{ jobType: "LOAD" }])
      await expect(observe(async()=>Response.json({ ...good,configuration: { ...good.configuration,...substitute } }))).rejects.toThrow("Unmatched");
    await expect(observe(async()=>Response.json({ ...good,status: { state: "DONE",errorResult: {} } }))).rejects.toThrow("Malformed");
    await expect(observe(async()=>new Response(null,{ status: 503 }))).rejects.toThrow("lookup failed");
    await expect(observe(async()=>{ throw new Error("lookup timeout"); })).rejects.toThrow("timeout");
    expect(await rows()).toBe(0);
  });

  it("requires both a confirmed claim and a current owner in the specific tenant and audience", async () => {
    const lookup = vi.fn(async()=>missing());
    await sql("INSERT INTO control_tenants VALUES('peer','Peer')");
    await sql("INSERT INTO control_memberships VALUES('peer','google:operator','owner',1)");
    for (const [who,scope,id] of [[{ ...owner,tenantId:"peer" },audience,intentId],
      [{ ...owner,principalId:"google:reader" },audience,intentId],[owner,"other",intentId],[owner,audience,"unknown"]] as const)
      await expect(observeDelegatedClaim(who,scope,id,lookup)).rejects.toThrow("claim unavailable");
    file = join(dir,crypto.randomUUID()+".db");
    await copyFile(prepared,file);
    await upgrade();
    await expect(observe(lookup)).rejects.toThrow("claim unavailable");
    expect(lookup).not.toHaveBeenCalled();
  });
  it.each(["terminal","not-found","pending"])("rechecks owner after the lookup: %s", async kind => {
    await expect(observe(async()=>{
      await sql("UPDATE control_memberships SET active=0 WHERE tenant_id='t' AND principal_id='google:operator'");
      return kind==="not-found" ? missing() : Response.json(resource(kind==="pending" ? "PENDING" : "DONE","5"));
    })).rejects.toThrow();
    expect(await rows()).toBe(0);
  });
  it("deduplicates concurrent samples, rejects contradictory outcomes and preserves the first witnesses", async () => {
    const cancelled = () => observe(async()=>Response.json(resource("DONE",undefined,"stopped")));
    const [a,b] = await Promise.all([cancelled(),cancelled()]);
    expect(b).toEqual(a);
    expect(a.observation).toMatchObject({ state: "cancelled",billedBytes: null });
    expect(await rows()).toBe(1);
    const enriched = await observeDelegatedClaim({ ...owner,principalId:"google:owner" },audience,intentId,
      async()=>Response.json(resource("DONE","12","stopped")));
    expect(enriched.observation).toMatchObject({ state:"cancelled",billedBytes:12,observedBy:"google:owner" });
    await expect(observe(async()=>Response.json(resource("DONE","14","stopped")))).rejects.toThrow("conflicting");
    await expect(observe(async()=>Response.json(resource("DONE",undefined,"invalidQuery")))).rejects.toThrow("conflicting");
    expect(await cancelled()).toEqual(enriched);
    expect(await rows()).toBe(2);
  });
  it("recovers locally after losing confirmation of the terminal write; no second lookup or claim is needed", async () => {
    const hooked: typeof db = { prepare(q) {
      const p = db.prepare(q);
      if (!q.startsWith("INSERT INTO bigquery_terminal_observations")) return p;
      return { ...p,bind(...args) {
        const stmt = p.bind(...args);
        return { ...stmt,async run() { await stmt.run(); throw new Error("fixture: confirmation lost"); } };
      } };
    } };
    const lookup = vi.fn(async()=>Response.json(resource("DONE","7","invalidQuery")));
    await expect(observeDelegatedClaim({ ...owner,db:hooked },audience,intentId,lookup)).rejects.toThrow("confirmation lost");
    expect((await stored()).observation).toMatchObject({ state:"failed",billedBytes:7 });
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(await rows()).toBe(1);
    expect(await ledger()).toMatchObject({ claims:1,settlements:0,reserved:100,receiptState:"pending" });
  });
  it("does not backfill pre-upgrade metadata with an invented claim witness", async () => {
    const raw = "INSERT INTO bigquery_terminal_observations(tenant_id,intent_id,outcome,billed_bytes,has_bytes,observed_by) VALUES('t',?,'failed',NULL,0,'google:operator')";
    await expect(sql(raw,[intentId])).rejects.toThrow("verified delegated observation required");
    file = join(dir,crypto.randomUUID()+".db");
    await copyFile(claimed,file);
    await sql(raw,[intentId]);
    await upgrade();
    const lookup = vi.fn();
    await expect(observe(lookup)).rejects.toThrow("claim unavailable");
    expect(lookup).not.toHaveBeenCalled();
    expect(await first("SELECT outcome,claim_body_digest,delegation_audience FROM bigquery_terminal_observations"))
      .toEqual({ outcome:"failed",claim_body_digest:null,delegation_audience:null });
  });
  it("rejects a mismatched claim digest or audience even when the writer is an active owner", async () => {
    const { digest } = await first("SELECT compiled_body_digest digest FROM dispatch_claims");
    const insert = `INSERT INTO bigquery_terminal_observations
      (tenant_id,intent_id,outcome,billed_bytes,has_bytes,observed_by,delegation_audience,claim_body_digest)
      VALUES('t',?,'succeeded',0,1,'google:operator',?,?)`;
    for (const [scope,pin] of [["other",digest],[audience,"sha256:"+"f".repeat(64)]])
      await expect(sql(insert,[intentId,scope,pin])).rejects.toThrow("verified delegated observation required");
    expect(await rows()).toBe(0);
  });
});
