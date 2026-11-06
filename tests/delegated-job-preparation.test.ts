import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { observePreparedIntentJob, prepareIntentJob } from "../lib/bigquery-job-storage";
import { dispatchPreparedMetricRead } from "../lib/dispatch-authority";
import { stopBeforeDispatch } from "../lib/pre-dispatch-stop";
import { SESSION_COOKIE, signAuthPayload } from "../lib/auth";
import worker from "../worker";
import { delegationFixture } from "./fixtures/delegation";
import { jobSqlite } from "./fixtures/job-sqlite";

let file: string, dir: string, baseline: string, enrolled: CryptoKeyPair;
let intentId: string, contractId: string, delegationId: string;
const { db, env, first, sql, keys, post, origin, seedAdmittedDelegation, revoke } =
  delegationFixture(() => file, () => enrolled);
const operator = { tenantId: "t", principalId: "google:operator", db };
const target = { BIGQUERY_PROJECT_ID: "demo-project", BIGQUERY_LOCATION: "US" };
const prepare = (bindings = env) => post("t/job-preparations", { intentId }, "operator", bindings);
const counts = () => first(`SELECT (SELECT count(*) FROM bigquery_job_bindings) jobs,
  (SELECT count(*) FROM evidence_receipts) receipts, (SELECT count(*) FROM control_object_events WHERE object_kind='receipt') events,
  (SELECT reserved_units FROM control_budgets WHERE tenant_id='t' AND id='b') reserved,(SELECT count(*) FROM dispatch_claims) claims`);

describe("delegated job preparation", { timeout: 25000 }, () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "odap-delegated-job-"));
    file = baseline = join(dir, "admitted-v22.db");
    enrolled = await keys();
    ({ delegationId,contractId,intentId } = await seedAdmittedDelegation());
    await prepareIntentJob(operator, "i", target); // A pre-existing non-delegated binding.
  }, 30000);
  beforeEach(async () => {
    file = join(dir, crypto.randomUUID()+".db");
    await copyFile(baseline,file);
    await jobSqlite(file,"apply-delegated-jobs");
  });
  afterAll(async () => { if (dir) await rm(dir,{ recursive: true, force: true }); });

  it("upgrades without assigning limits to old jobs; concurrent calls create just one bounded binding and readable pending receipt", async () => {
    expect(await first("SELECT delegation_audience AS audience,prepared_rate AS rate FROM bigquery_job_bindings WHERE intent_id='i'"))
      .toEqual({ audience: null, rate: null });
    const before = await counts();
    const [a,b] = await Promise.all([prepare(),prepare()]);
    expect([a.status,b.status].sort()).toEqual([200,201]);
    const body = await a.json() as { preparation: { jobReference: { jobId: string }; receiptId: string } };
    expect(await b.json()).toEqual(body);
    expect(body.preparation).toEqual({ intentId, maximumBytesBilled: "17592186", jobReference: {
      projectId: "demo-project", location: "US", jobId: expect.stringMatching(/^odap_[a-f0-9]{64}$/) },
      receiptId: "pending_"+body.preparation.jobReference.jobId });
    const path = "/api/control/t/receipt/"+body.preparation.receiptId;
    expect([a,b].map(r=>r.headers.get("Location"))).toEqual([path,path]);
    const token = await signAuthPayload({ provider: "google", providerId: "operator", name: "Operator",
      email: "fixture@example.test", expiresAt: Date.now()+60000 },env.AUTH_COOKIE_SECRET);
    const receipt = await worker.fetch(new Request(origin+path,{ headers: { Cookie: SESSION_COOKIE+"="+token } }),env,{ waitUntil: () => undefined });
    expect(receipt.status).toBe(200);
    expect(await receipt.json()).toMatchObject({ object: { intentId, contractId, semanticReleaseId: "released", outcome: "pending" } });
    expect(await revoke(delegationId).then(r=>r.status)).toBe(200);
    expect((await prepare()).status).toBe(409);
    expect(await counts()).toEqual({ ...before, jobs: before.jobs+1, receipts: before.receipts+1, events: before.events+1 });
  });

  it("refuses foreign scope, requester credentials, forged terms and unscoped legacy preparation", async () => {
    const before = await counts();
    expect((await post("t/job-preparations",{ intentId })).status).toBe(401);
    expect((await post("t/job-preparations",{ intentId },"reader")).status).toBe(403);
    expect((await prepare({ ...env, ODAP_DELEGATION_AUDIENCE: "wrong" })).status).toBe(409);
    await sql("INSERT INTO control_tenants VALUES('peer','Peer')");
    await sql("INSERT INTO control_memberships VALUES('peer','google:operator','owner',1)");
    expect((await post("peer/job-preparations",{ intentId },"operator")).status).toBe(409);
    for (const extra of [{ jobId: "custom" }, { projectId: "another" }, { maximumBytesBilled: "1" }])
      expect((await post("t/job-preparations",{ intentId, ...extra },"operator")).status).toBe(400);
    await expect(prepareIntentJob(operator,intentId,target)).rejects.toThrow("delegated preparation required");
    await expect(sql(`INSERT INTO bigquery_job_bindings(tenant_id,intent_id,project_id,location,job_id,action_tag,
      receipt_id,prepared_by,delegation_audience,prepared_reserved_units,prepared_rate,prepared_byte_limit)
      VALUES('t',?,'demo-project','US',?,?,?,'google:operator','test-gateway',80,5000000,200000000)`,
      [intentId,"odap_"+"a".repeat(64),"b".repeat(48),"pending_odap_"+"a".repeat(64)])).rejects.toThrow("delegated preparation required");
    expect(await counts()).toEqual(before);
  });

  it("orders an operator stop against preparation on independent connections, without a claim or refund", async () => {
    const before = await counts();
    const [result,stop] = await Promise.all([prepare(),stopBeforeDispatch(operator,intentId)]);
    expect(stop.state).toBe("stopped");
    expect([201,409]).toContain(result.status);
    expect((await prepare()).status).toBe(409);
    const n = Number(result.status===201);
    expect(await counts()).toEqual({ ...before, jobs: before.jobs+n, receipts: before.receipts+n, events: before.events+n });
  });

  it.each(["revoke","stop","rate expires","owner withdrawn","key disabled","overrun","target changed","lost confirmation"])(
    "rechecks authority or recovers the original write: %s", async change => {
      const before = await counts();
      let writes = 0;
      const hooked: typeof db = { prepare(q) {
        const p = db.prepare(q);
        if (!q.startsWith("INSERT INTO bigquery_job_bindings")) return p;
        return { ...p, bind(...args) {
          const stmt = p.bind(...args);
          return { ...stmt, async first<T>() {
            writes++;
            if (change === "revoke") expect((await revoke(delegationId)).status).toBe(200);
            if (change === "stop") expect((await stopBeforeDispatch(operator,intentId)).state).toBe("stopped");
            if (change === "rate expires") return jobSqlite(file,"first-at-scan-expiry",q,args);
            if (change === "owner withdrawn") await sql("UPDATE control_memberships SET active=0 WHERE principal_id='google:operator'");
            if (change === "key disabled") await sql("UPDATE agent_verification_keys SET active=0");
            if (change === "overrun") await sql("UPDATE control_budgets SET overrun_units=1");
            if (change === "target changed") await sql("UPDATE dispatch_targets SET location='EU'");
            const row = await stmt.first<T>();
            if (change === "lost confirmation") { expect(row).toBeTruthy(); throw new Error("fixture: lost write response"); }
            return row;
          } };
        } };
      } };
      const response = await prepare({ ...env, DB: hooked });
      expect(writes).toBe(1);
      if (change === "lost confirmation") {
        expect(response.status).toBe(503);
        const stored = await db.prepare("SELECT job_id FROM bigquery_job_bindings WHERE tenant_id='t' AND intent_id=?")
          .bind(intentId).first<{ job_id: string }>();
        const replay = await prepare();
        expect(replay.status).toBe(200);
        expect(await replay.json()).toMatchObject({ preparation: { jobReference: { jobId: stored!.job_id } } });
        expect(await counts()).toEqual({ ...before, jobs: before.jobs+1, receipts: before.receipts+1, events: before.events+1 });
      } else {
        expect(response.status).toBe(409);
        expect(await counts()).toEqual(before);
      }
    });

  it("rolls back the binding when receipt auditing fails and still blocks all legacy handoff after recovery", async () => {
    const before = await counts();
    await sql("CREATE TRIGGER fail_pending BEFORE INSERT ON control_object_events WHEN NEW.object_kind='receipt' BEGIN SELECT RAISE(ABORT,'fixture fault'); END");
    expect((await prepare()).status).toBe(503);
    expect(await counts()).toEqual(before);
    await sql("DROP TRIGGER fail_pending");
    expect((await prepare()).status).toBe(201);
    const loadDefinition = vi.fn(), prepareRead = vi.fn();
    await expect(dispatchPreparedMetricRead(operator,intentId,{ principalId: "google:reader", agentId: "reporter" },
      { target: "orders", metricId: "revenue", parameters: { year: 2026 } },
      { projectId: "demo-project", location: "US", loadDefinition, prepareRead })).rejects.toThrow("handoff disabled");
    expect(loadDefinition).not.toHaveBeenCalled();
    expect(prepareRead).not.toHaveBeenCalled();
    await expect(observePreparedIntentJob(operator,intentId,target)).rejects.toThrow("handoff disabled");
    await expect(sql("INSERT INTO dispatch_claims(tenant_id,intent_id,claimed_by,maximum_bytes_billed) VALUES('t',?,'google:operator',1)",[intentId]))
      .rejects.toThrow("delegated dispatch disabled");
    expect(await counts()).toEqual({ ...before, jobs: before.jobs+1, receipts: before.receipts+1, events: before.events+1 });
  });
});
