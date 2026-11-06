import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { handoffDelegatedRead } from "../lib/delegated-handoff";
import { canonicalControlJson, sha256Text } from "../lib/control-objects";
import { dispatchBigQueryMetricRead } from "../lib/bigquery-governed-transport";
import { bigQueryByteCeiling } from "../lib/bigquery-byte-ceiling";
import { stopBeforeDispatch } from "../lib/pre-dispatch-stop";
import { delegationFixture } from "./fixtures/delegation";
import { jobSqlite } from "./fixtures/job-sqlite";

let dir: string, baseline: string, file: string, enrolled: CryptoKeyPair;
let intentId: string, delegationId: string, jobId: string, receiptId: string;
const { db, first, sql, keys, post, seedAdmittedDelegation, revoke } = delegationFixture(() => file, () => enrolled);
const owner = { db, tenantId: "t", principalId: "google:operator" };
const subject = { principalId: "google:reader", agentId: "reporter", audience: "test-gateway" };
const action = { target: "orders", metricId: "revenue", parameters: { year: 2026 } };
const handoff = (send: (body: string) => Promise<void>, access = owner) =>
  handoffDelegatedRead(access,intentId,subject,action,send);
const ledger = () => first(`SELECT (SELECT count(*) FROM dispatch_claims) claims,
  (SELECT reserved_units FROM control_budgets WHERE tenant_id='t' AND id='b') reserved,
  (SELECT count(*) FROM cost_settlements) settlements,(SELECT count(*) FROM evidence_receipts) receipts`);

describe("delegated one-time handoff (local sender)", { timeout: 25000 }, () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(),"odap-handoff-"));
    file = baseline = join(dir,"prepared-v23.db");
    enrolled = await keys();
    ({ intentId, delegationId } = await seedAdmittedDelegation());
    await jobSqlite(file,"apply-delegated-jobs");
    const prepared = await post("t/job-preparations",{ intentId },"operator");
    expect(prepared.status).toBe(201);
    const data = (await prepared.json() as { preparation: { jobReference: { jobId: string }; receiptId: string } }).preparation;
    jobId = data.jobReference.jobId;
    receiptId = data.receiptId;
  }, 30000);
  beforeEach(async () => {
    file = join(dir,crypto.randomUUID()+".db");
    await copyFile(baseline,file);
    await jobSqlite(file,"apply-delegated-handoff");
  });
  afterAll(async () => { if (dir) await rm(dir,{ recursive: true, force: true }); });

  it("compiles the approved action and commits the digest of the exact sender bytes before a single concurrent handoff", async () => {
    const before = await ledger();
    const send = vi.fn(async (body: string) => {
      expect(JSON.parse(body)).toEqual({ jobReference: { projectId: "demo-project", location: "US", jobId },
        configuration: { labels: { odap_action: expect.stringMatching(/^[0-9a-f]{48}$/) }, query: {
          query: "SELECT SUM(`net_amount`) AS metric_value FROM `demo-project.analytics.orders` WHERE `order_year` = @p0",
          parameterMode: "NAMED", useLegacySql: false, maximumBytesBilled: "17592186", queryParameters: [
            { name: "p0", parameterType: { type: "INT64" }, parameterValue: { value: "2026" } }] } } });
      expect(await first("SELECT maximum_bytes_billed AS cap,compiled_body_digest AS digest,delegation_audience AS audience,claimed_by AS actor FROM dispatch_claims"))
        .toEqual({ cap: 17592186, digest: await sha256Text(body), audience: subject.audience, actor: owner.principalId });
    });
    const results = await Promise.allSettled([handoff(send),handoff(send)]);
    expect(results.filter(r=>r.status==="fulfilled")).toEqual([{ status: "fulfilled", value: {
      state: "handed-off", jobReference: { projectId: "demo-project", location: "US", jobId }, receiptId } }]);
    expect(send).toHaveBeenCalledTimes(1);
    expect((await stopBeforeDispatch(owner,intentId)).state).toBe("already-claimed");
    expect(await ledger()).toEqual({ ...before, claims: 1 });
  });

  it("refuses mismatched scope or action, missing digest and either side of the funded byte ceiling", async () => {
    const send = vi.fn();
    for (const other of [{ ...subject, principalId: "google:operator" },{ ...subject, agentId: "other" },{ ...subject, audience: "other" }])
      await expect(handoffDelegatedRead(owner,intentId,other,action,send)).rejects.toThrow();
    await expect(handoff(send,{ ...owner, tenantId: "other" })).rejects.toThrow();
    await expect(handoff(send,{ ...owner, principalId: "google:reader" })).rejects.toThrow();
    await expect(handoffDelegatedRead(owner,intentId,subject,{ ...action, parameters: { year: 2025 } },send)).rejects.toThrow();
    const raw = "INSERT INTO dispatch_claims(tenant_id,intent_id,claimed_by,maximum_bytes_billed,delegation_audience,compiled_body_digest) VALUES('t',?,'google:operator',?,'test-gateway',?)";
    for (const cap of [17592185,17592187]) await expect(sql(raw,[intentId,String(cap),"sha256:"+"f".repeat(64)])).rejects.toThrow();
    await expect(sql(raw,[intentId,"17592186","bad"])).rejects.toThrow();
    await expect(sql("INSERT INTO dispatch_claims(tenant_id,intent_id,claimed_by,maximum_bytes_billed) VALUES('t',?,'google:operator',17592186)",[intentId])).rejects.toThrow();
    expect((await ledger()).claims).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it("will not hand off a different but internally consistent metric snapshot returned at preflight", async () => {
    let attempts = 0;
    const hooked: typeof db = { prepare(q) {
      const p = db.prepare(q);
      if (q.startsWith("INSERT INTO dispatch_claims")) attempts++;
      if (!q.startsWith("SELECT contract_payload,release_payload")) return p;
      return { ...p, bind(...args) {
        const stmt = p.bind(...args);
        return { ...stmt, async first<T>() {
          const row = await stmt.first<{ definition_json: string; release_payload: string }>();
          if (!row) throw new Error("fixture: missing preflight");
          const definition = JSON.parse(row.definition_json), release = JSON.parse(row.release_payload);
          definition.measure.column = "gross_amount";
          release.definitionDigest = await sha256Text(canonicalControlJson(definition));
          return { ...row, definition_json: JSON.stringify(definition), release_payload: JSON.stringify(release) } as T;
        } };
      } };
    } };
    const send = vi.fn();
    await expect(handoff(send,{ ...owner, db: hooked })).rejects.toThrow("not confirmed");
    expect(attempts).toBe(1);
    expect((await ledger()).claims).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it("keeps the legacy transport locked out both before and after a delegated handoff", async () => {
    const transport = { projectId: "demo-project", location: "US", maxBytesBilled: 17592186,
      loadDefinition: vi.fn(), getAccessToken: vi.fn(), sendOnce: vi.fn() };
    const legacy = () => dispatchBigQueryMetricRead(owner,intentId,subject,action,transport);
    await expect(legacy()).rejects.toThrow("handoff disabled");
    expect((await handoff(vi.fn())).state).toBe("handed-off");
    await expect(legacy()).rejects.toThrow("handoff disabled");
    expect(transport.loadDefinition).not.toHaveBeenCalled();
    expect(transport.getAccessToken).not.toHaveBeenCalled();
    expect(transport.sendOnce).not.toHaveBeenCalled();
  });

  it.each(["stop","withdraw","rate expired","target drift","disable operator","budget overrun","lost commit response"])(
    "does not send if the final write cannot confirm authority: %s", async change => {
      const before = await ledger(), send = vi.fn();
      let writes = 0;
      const hooked: typeof db = { prepare(q) {
        const p = db.prepare(q);
        if (!q.startsWith("INSERT INTO dispatch_claims")) return p;
        return { ...p, bind(...args) {
          const stmt = p.bind(...args);
          return { ...stmt, async first<T>() {
            writes++;
            if (change === "stop") expect((await stopBeforeDispatch(owner,intentId)).state).toBe("stopped");
            if (change === "withdraw") expect((await revoke(delegationId)).status).toBe(200);
            if (change === "rate expired") return jobSqlite(file,"first-at-scan-expiry",q,args);
            if (change === "target drift") await sql("UPDATE dispatch_targets SET location='EU'");
            if (change === "disable operator") await sql("UPDATE control_memberships SET active=0 WHERE principal_id='google:operator'");
            if (change === "budget overrun") await sql("UPDATE control_budgets SET overrun_units=1");
            const row = await stmt.first<T>();
            if (change === "lost commit response") throw new Error("fixture: commit response lost");
            return row;
          } };
        } };
      } };
      await expect(handoff(send,{ ...owner, db: hooked })).rejects.toThrow();
      expect(writes).toBe(1);
      if (change === "lost commit response") await expect(handoff(send)).rejects.toThrow();
      expect(send).not.toHaveBeenCalled();
      expect(await ledger()).toEqual({ ...before, claims: Number(change==="lost commit response") });
    });

  it.each(["stop","revoke"])("serializes concurrent %s and claim on independent connections", async kind => {
    const send = vi.fn();
    const [result, decision] = await Promise.all([handoff(send).then(()=>1,()=>0),
      kind==="stop" ? stopBeforeDispatch(owner,intentId).then(r=>r.state) : revoke(delegationId).then(r=>String(r.status))]);
    expect(decision).toBe(kind==="stop" ? (result ? "already-claimed" : "stopped") : "200");
    await expect(handoff(send)).rejects.toThrow();
    expect(send).toHaveBeenCalledTimes(result);
    expect((await ledger()).claims).toBe(result);
  });
  it("retains a claim, pending evidence and reservation across sender timeout and restart", async () => {
    const before = await ledger(), send = vi.fn(async () => { throw new Error("ambiguous timeout"); });
    expect(await handoff(send)).toMatchObject({ state: "observation-required", jobReference: { jobId }, receiptId });
    await expect(handoff(send)).rejects.toThrow();
    expect(send).toHaveBeenCalledTimes(1);
    expect(await ledger()).toEqual({ ...before, claims: 1 });
    expect(await first("SELECT json_extract(payload,'$.outcome') outcome FROM evidence_receipts")).toEqual({ outcome: "pending" });
  });

  it("matches the exact BigInt bound at precision and saturation boundaries", async () => {
    const math = join(dir,"cap-arithmetic.db");
    // Isolate the shipped view from authorization to exercise extreme inputs.
    const { sql: capView } = await first("SELECT sql FROM sqlite_schema WHERE name='delegated_prepared_caps'");
    await jobSqlite(math,"run","CREATE TABLE bigquery_job_bindings(tenant_id,intent_id,delegation_audience,prepared_reserved_units INTEGER,prepared_rate INTEGER,prepared_byte_limit INTEGER)");
    await jobSqlite(math,"run",capView);
    const max = Number.MAX_SAFE_INTEGER;
    for (const [units,rate,limit] of [[max,max,max],[max-1,max,max],[max,1,max],[1,2**40,max],
      [1,2**40+1,max],[17,3,123],[4095,max,1],[80,5000000,100000000]]) {
      await jobSqlite(math,"run","INSERT INTO bigquery_job_bindings VALUES('t',?,'scope',?,?,?)",[String(rate)+":"+units,units,rate,limit]);
      const { cap } = await jobSqlite(math,"first","SELECT byte_cap AS cap FROM delegated_prepared_caps WHERE intent_id=?",[String(rate)+":"+units]);
      if (BigInt(units)*(1n<<40n)<BigInt(rate)) expect(cap).toBe(0);
      else expect(cap).toBe(bigQueryByteCeiling(units,rate,limit));
    }
  });
});
