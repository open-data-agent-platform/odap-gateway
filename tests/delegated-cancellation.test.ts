import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { delegationFixture } from "./fixtures/delegation";
import { delegatedCancellationCases, type CancellationFixture } from "./fixtures/delegated-cancellation-cases";
import { jobSqlite } from "./fixtures/job-sqlite";
import { readDelegatedCancellation, requestDelegatedCancellation } from "../lib/delegated-cancellation";
import { sendRequestedDelegatedJobCancellation } from "../lib/bigquery-cancellation-transport";
import { cancellationEvidenceCases } from "./fixtures/cancellation-evidence-cases";
import { exportCancellationEvidence } from "../lib/cancellation-evidence-export";
import { jobDatabase } from "./fixtures/job-sqlite";
import { buildDetachedVerifier } from "./fixtures/detached-verifier";
import { delegatedObservationTransportCases } from "./fixtures/delegated-observation-transport-cases";
import { delegatedRecoveryRequestCases, recoveryCookie, recoveryEnv, recoveryRequest } from "./fixtures/delegated-recovery-request-cases";
import { requestDelegatedRecovery } from "../lib/delegated-recovery-request";
import { delegatedRecoveryMcpCases, recoveryToolBody } from "./fixtures/delegated-recovery-mcp-cases";

let dir: string, file: string, claimed: string, prepared: string, enrolled: CryptoKeyPair, f: CancellationFixture;
const fixture = delegationFixture(() => file, () => enrolled), { db, sql, first } = fixture;
const owner = { db, tenantId: "t", principalId: "google:operator" }, audience = "test-gateway";
const upgrade = () => jobSqlite(file, "apply-delegated-cancellation");
const read = () => readDelegatedCancellation(owner, audience, f.intentId);

describe("delegated cancellation storage and upgrade", { timeout: 25000 }, () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "odap-delegated-cancel-")); file = claimed = join(dir, "claimed.db"); prepared = join(dir, "prepared.db");
    enrolled = await fixture.keys();
    const job = await fixture.seedAmbiguousDelegation(() => copyFile(file, prepared));
    f = { ...job, owner, audience, sql, first, revoke: fixture.revoke };
  }, 60000);
  beforeEach(async () => {
    file = join(dir, crypto.randomUUID() + ".db"); await copyFile(claimed, file);
    await jobSqlite(file, "apply-delegated-observations"); await upgrade();
  });
  afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });
  delegatedCancellationCases(() => f);
  cancellationEvidenceCases(() => f);
  delegatedObservationTransportCases(() => f);
  delegatedRecoveryRequestCases(() => f);
  delegatedRecoveryMcpCases(() => f);

  it("reads schema 0025 through a read-only connection without upgrading or changing bytes", async () => {
    file = join(dir, crypto.randomUUID()+".db"); await copyFile(claimed,file);
    await jobSqlite(file,"apply-delegated-observations");
    const before = await readFile(file), readonly = jobDatabase(() => file,"readonly");
    const result = await requestDelegatedRecovery(recoveryRequest(await recoveryCookie(),f.intentId),recoveryEnv(readonly),"t",f.intentId);
    expect(result.status).toBe(200); expect(result.body).toMatchObject({ recovery: { observation: null } });
    expect(await recoveryToolBody(recoveryRequest(await recoveryCookie(),f.intentId),recoveryEnv(readonly),"t",f.intentId)).toEqual(result.body);
    expect(await readFile(file)).toEqual(before);
  });
  it("reports pre-0025 storage unavailable only after authentication without upgrading", async () => {
    file = join(dir, crypto.randomUUID()+".db"); await copyFile(claimed,file);
    const before = await readFile(file), readonly = jobDatabase(() => file,"readonly"), env = recoveryEnv(readonly);
    expect((await requestDelegatedRecovery(recoveryRequest(await recoveryCookie("reader"),f.intentId),env,"t",f.intentId)).status).toBe(403);
    const result = await requestDelegatedRecovery(recoveryRequest(await recoveryCookie(),f.intentId),env,"t",f.intentId);
    expect(result).toEqual({ status: 503, body: { ok: false, code: "job_recovery_unavailable" } });
    expect(await recoveryToolBody(recoveryRequest(await recoveryCookie("reader"),f.intentId),env,"t",f.intentId)).toEqual({ ok: false,code: "tenant_access_denied" });
    expect(await recoveryToolBody(recoveryRequest(await recoveryCookie(),f.intentId),env,"t",f.intentId)).toEqual(result.body);
    expect(await readFile(file)).toEqual(before);
  });
  it("refuses recovery of a prepared but unclaimed job through the authenticated API", async () => {
    file = join(dir, crypto.randomUUID()+".db"); await copyFile(prepared,file);
    await jobSqlite(file,"apply-delegated-observations");
    expect(await requestDelegatedRecovery(recoveryRequest(await recoveryCookie(),f.intentId),recoveryEnv(db),"t",f.intentId))
      .toEqual({ status: 403, body: { ok: false, code: "tenant_access_denied" } });
    expect(await recoveryToolBody(recoveryRequest(await recoveryCookie(),f.intentId),recoveryEnv(db),"t",f.intentId))
      .toEqual({ ok: false,code: "tenant_access_denied" });
  });

  it("reads the export through a read-only SQLite connection", async () => {
    await requestDelegatedCancellation(owner,audience,f.intentId);
    const saved=await exportCancellationEvidence({ ...owner,db:jobDatabase(() => file,"readonly") },audience,f.intentId);
    expect(saved).toEqual(await exportCancellationEvidence(owner,audience,f.intentId));
    if(!saved) throw new Error("Missing export");
    const path=join(dir,"request.json"),pin=join(dir,"request.sha256");
    await writeFile(path,saved.json); await writeFile(pin,saved.digest);
    const invoke=await buildDetachedVerifier(dir,"verify-cancellation-evidence");
    const checked=await invoke(path,"t",f.intentId,audience,pin);
    expect(checked.stderr).toBe(""); expect(JSON.parse(checked.stdout)).toMatchObject({consistent:true,cancellationConfirmed:false});
  });

  it("keeps an unattributed pre-upgrade request unverified and never sends it", async () => {
    file = join(dir, crypto.randomUUID() + ".db"); await copyFile(claimed, file);
    await jobSqlite(file, "apply-delegated-observations");
    await sql("INSERT INTO bigquery_cancellation_requests(tenant_id,intent_id,job_id,requested_by) VALUES('t',?,?,'google:operator')", [f.intentId, f.ref.jobId]);
    const original = await first("SELECT * FROM bigquery_cancellation_requests"); await upgrade();
    const stored = await read(); expect(stored).toMatchObject({ state: "unverified-request", request: { verified: false } });
    expect(await exportCancellationEvidence(owner,audience,f.intentId)).toBeNull();
    expect(await requestDelegatedCancellation(owner, audience, f.intentId)).toEqual(stored);
    const getAccessToken = vi.fn(), sendOnce = vi.fn();
    expect(await sendRequestedDelegatedJobCancellation(owner, audience, f.intentId, { getAccessToken, sendOnce }))
      .toMatchObject({ state: "not-sent", reason: "unverified-request" });
    expect(getAccessToken).not.toHaveBeenCalled(); expect(sendOnce).not.toHaveBeenCalled();
    expect(await first("SELECT * FROM bigquery_cancellation_requests")).toEqual({ ...original, delegation_audience: null, claim_body_digest: null });
  });
  it("refuses schema 0033 or earlier without a default sender", async () => {
    file = join(dir, crypto.randomUUID() + ".db"); await copyFile(claimed, file);
    await jobSqlite(file, "apply-delegated-observations");
    const getAccessToken = vi.fn(), sendOnce = vi.fn();
    await expect(exportCancellationEvidence(owner,audience,f.intentId)).rejects.toThrow();
    await expect(sendRequestedDelegatedJobCancellation(owner, audience, f.intentId, { getAccessToken, sendOnce })).rejects.toThrow("unavailable");
    expect(getAccessToken).not.toHaveBeenCalled(); expect(sendOnce).not.toHaveBeenCalled();
  });
  it("refuses a prepared but unclaimed delegated job", async () => {
    file = join(dir, crypto.randomUUID() + ".db"); await copyFile(prepared, file);
    await jobSqlite(file, "apply-delegated-observations"); await upgrade();
    await expect(requestDelegatedCancellation(owner, audience, f.intentId)).rejects.toThrow("claim unavailable");
    expect(await first("SELECT count(*) AS n FROM bigquery_cancellation_requests")).toEqual({ n: 0 });
  });
  it("recovers a persisted request after lost write confirmation without submitting anything", async () => {
    const hooked: typeof db = { prepare(q) {
      const p = db.prepare(q); if (!q.startsWith("INSERT INTO bigquery_cancellation_requests")) return p;
      return { ...p, bind(...args) { const s = p.bind(...args); return { ...s, async run() {
        await s.run(); throw new Error("fixture: confirmation lost");
      } }; } };
    } };
    await expect(requestDelegatedCancellation({ ...owner, db: hooked }, audience, f.intentId)).rejects.toThrow("confirmation lost");
    const saved = await read(); expect(saved.state).toBe("requested");
    expect(await requestDelegatedCancellation(owner, audience, f.intentId)).toEqual(saved);
  });
  it("does not write if ownership is revoked between the read and conditional insert", async () => {
    const hooked: typeof db = { prepare(q) {
      const p = db.prepare(q); if (!q.startsWith("INSERT INTO bigquery_cancellation_requests")) return p;
      return { ...p, bind(...args) { const s = p.bind(...args); return { ...s, async run() {
        await sql("UPDATE control_memberships SET active=0 WHERE tenant_id='t' AND principal_id='google:operator'"); return s.run();
      } }; } };
    } };
    await expect(requestDelegatedCancellation({ ...owner, db: hooked }, audience, f.intentId)).rejects.toThrow("scope unavailable");
    expect(await first("SELECT count(*) AS n FROM bigquery_cancellation_requests")).toEqual({ n: 0 });
  });
});
