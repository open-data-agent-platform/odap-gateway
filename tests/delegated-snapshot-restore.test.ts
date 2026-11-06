import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readDelegatedBilling, reconcileDelegatedBill } from "../lib/delegated-billing";
import { observeDelegatedClaim, readDelegatedRecovery } from "../lib/delegated-job-recovery";
import { readEvidenceCoverage } from "../lib/evidence-coverage";
import { exportSettledEvidence } from "../lib/settled-evidence-export";
import { delegationFixture } from "./fixtures/delegation";
import { buildDetachedVerifier } from "./fixtures/detached-verifier";
import { jobDatabase, jobSqlite } from "./fixtures/job-sqlite";

const audience = "test-gateway";
const scope = { tenantId: "t", principalId: "google:owner" };
const sha = (bytes: Buffer | string) => "sha256:" + createHash("sha256").update(bytes).digest("hex");
const ro = (file: string) => ({ ...scope, db: jobDatabase(() => file, "readonly") });
let dir: string, intentId: string, jobId: string;
let verify: Awaited<ReturnType<typeof buildDetachedVerifier>>;
const retained = (name: string) => join(dir, "retained", name);
const snapshots = (phase: string) => join(dir, "snapshots", phase + ".sqlite");
const exec = promisify(execFile);
async function compareClaims(old: string, reference: string, expectedExit: 0 | 1 | 2) {
  const args = ["-B","scripts/check-restore-dispatch.py","--restored",old,"--reference",reference];
  const python = process.env.ODAP_TEST_PYTHON || (process.platform === "win32" ? "python" : "python3");
  const res = await exec(python,args).then(r => ({...r,code:0}), (e: { code:number; stdout:string; stderr:string }) => e);
  expect(res.code).toBe(expectedExit);
  if (expectedExit === 2) {
    expect(res.stdout).toBe("");
    expect(res.stderr).toMatch(/^No comparison:/);
    return null;
  }
  expect(res.stderr).toBe("");
  return JSON.parse(res.stdout);
}

async function inspect(file: string) {
  const access = ro(file);
  const budget = await jobSqlite(file, "readonly-first", `SELECT reserved_units,spent_units,overrun_units,
    (SELECT count(*) FROM cost_settlements WHERE tenant_id=? AND intent_id=?) settlements,
    (SELECT count(*) FROM bigquery_billing_evidence WHERE tenant_id=? AND intent_id=?) bills,
    (SELECT count(*) FROM evidence_receipts WHERE tenant_id=? AND json_extract(payload,'$.intentId')=?) receipts
    FROM control_budgets WHERE tenant_id=? AND id='b'`, ["t",intentId,"t",intentId,"t",intentId,"t"]);
  return { budget, coverage: await readEvidenceCoverage(access),
    recovery: await readDelegatedRecovery(access,audience,intentId),
    bill: await readDelegatedBilling(access,audience,intentId) };
}

describe("delegated point-in-time restore", () => {
  beforeAll(async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No provider access during restore drill"));
    dir = await mkdtemp(join(tmpdir(), "odap-delegated-restore-"));
    await mkdir(join(dir,"retained"));
    await mkdir(join(dir,"snapshots"));
    const live = join(dir, "live.sqlite");
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign","verify"]);
    const fixture = delegationFixture(() => live, () => pair);
    const seed = await fixture.seedAmbiguousDelegation(async () => {
      // Fork before the claim: the parked copy never runs a sender.
      await fixture.sql("VACUUM INTO ?",[snapshots("prepared")]);
      await copyFile(snapshots("prepared"),snapshots("parked"),constants.COPYFILE_EXCL);
    });
    await fixture.sql("VACUUM INTO ?",[snapshots("attempted")]);
    intentId = seed.intentId;
    jobId = seed.ref.jobId;
    await jobSqlite(live,"apply-delegated-observations");
    await jobSqlite(live,"apply-delegated-billing");
    expect((await fixture.revoke(seed.delegationId)).status).toBe(200);
    const operator = { ...scope, db: fixture.db, principalId: "google:operator" };
    await observeDelegatedClaim(operator,audience,intentId,async () => Response.json({
      jobReference: seed.ref, configuration: { jobType: "QUERY", labels: { odap_action: seed.tag },
        query: { maximumBytesBilled: seed.cap } }, status: { state: "DONE", errorResult: { reason: "stopped" } }
    }));
    for (const phase of ["pending","settled"] as const) {
      if (phase === "settled") {
        await reconcileDelegatedBill(operator,audience,intentId,async key => ({
          ...key, reference: "fixture:cancelled-charge", amount: 12, status: "final", unit: "micro-USD"
        }));
      }
      const state = await inspect(live);
      await writeFile(retained(phase + ".json"),JSON.stringify(state),{ flag: "wx" });
      const bundle = await exportSettledEvidence(ro(live),intentId,audience);
      if (phase === "pending") expect(bundle).toBeNull();
      else {
        if (!bundle) throw new Error("Missing original settled export");
        await writeFile(retained("original.json"),bundle.json,{ flag: "wx" });
        await writeFile(retained("original.sha256"),sha(bundle.json),{ flag: "wx" });
      }
      await fixture.sql("VACUUM INTO ?",[snapshots(phase)]);
    }
    verify = await buildDetachedVerifier(join(dir,"verifier"));
  }, 60_000);
  afterAll(async () => {
    vi.restoreAllMocks();
    if (dir) await rm(dir,{ recursive: true, force: true });
  });

  it("distinguishes a lost claim only with later evidence; the same prepared backup never authorizes a retry", async () => {
    const old = snapshots("prepared"), parked = snapshots("parked"), later = snapshots("attempted");
    const paths = [old,parked,later];
    const pins = await Promise.all(paths.map(async p => sha(await readFile(p))));
    expect(pins[0]).toBe(pins[1]);
    const q = `SELECT b.job_id AS jobId,json_extract(p.payload,'$.outcome') AS outcome,
      (SELECT count(*) FROM dispatch_claims h WHERE h.tenant_id=b.tenant_id AND h.intent_id=b.intent_id) AS claims
      FROM bigquery_job_bindings b JOIN evidence_receipts p ON p.tenant_id=b.tenant_id AND p.id=b.receipt_id
      WHERE b.tenant_id='t' AND b.intent_id=?`;
    for (const path of paths) expect(await jobSqlite(path,"readonly-first",q,[intentId])).toEqual({
      jobId,outcome:"pending",claims:Number(path === later)
    });
    const same = { claimComparison:"equal",referenceOnly:0,restoredOnly:0,changed:0,
      warehouseSubmission:"not_verified",retryAuthorized:false };
    expect(await compareClaims(old,parked,0)).toEqual(same);
    expect(await compareClaims(old,later,1)).toEqual({...same,claimComparison:"different",referenceOnly:1});
    expect(await compareClaims(later,old,1)).toEqual({...same,claimComparison:"different",restoredOnly:1});
    expect(await compareClaims(later,snapshots("settled"),0)).toEqual(same);
    expect(await Promise.all(paths.map(async p => sha(await readFile(p))))).toEqual(pins);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("detects changed pins even when both files have one claim for the same job", async () => {
    const original = snapshots("attempted"), changed = join(dir,"changed-claim.sqlite");
    await copyFile(original,changed,constants.COPYFILE_EXCL);
    await jobSqlite(changed,"run","DROP TRIGGER dispatch_claim_no_update");
    await jobSqlite(changed,"run","UPDATE dispatch_claims SET compiled_body_digest=? WHERE tenant_id='t' AND intent_id=?",
      ["sha256:"+"0".repeat(64),intentId]);
    expect(await compareClaims(original,changed,1)).toEqual({ claimComparison:"different",referenceOnly:0,
      restoredOnly:0,changed:1,warehouseSubmission:"not_verified",retryAuthorized:false });
  });

  it("never counts missing scope, missing columns or a repeated input file as an empty ledger", async () => {
    const source = snapshots("attempted"), broken = join(dir,"incomplete-claim.sqlite");
    await copyFile(source,broken,constants.COPYFILE_EXCL);
    await jobSqlite(broken,"run","DROP TRIGGER dispatch_claim_no_update");
    await jobSqlite(broken,"run","UPDATE dispatch_claims SET delegation_audience=NULL WHERE tenant_id='t' AND intent_id=?",[intentId]);
    expect(await compareClaims(source,broken,2)).toBeNull();
    expect(await compareClaims(source,source,2)).toBeNull();
    const old = join(dir,"old-schema.sqlite");
    await jobSqlite(old,"setup-v6");
    expect(await compareClaims(old,source,2)).toBeNull();
  });

  it.each(["pending","settled"] as const)("restores the %s snapshot with no provider call or write", async phase => {
    const restored = join(dir,phase + "-restored.sqlite");
    await copyFile(snapshots(phase),restored,constants.COPYFILE_EXCL);
    const before = sha(await readFile(restored));
    expect(await jobSqlite(restored,"readonly-first","PRAGMA integrity_check")).toEqual({ integrity_check: "ok" });
    expect(await jobSqlite(restored,"readonly-first","PRAGMA foreign_key_check")).toBeNull();
    const state = await inspect(restored);
    expect(state).toEqual(JSON.parse(await readFile(retained(phase + ".json"),"utf8")));
    const paid = phase === "settled";
    // Twenty units belong to a separate admission and must remain reserved.
    expect(state.budget).toEqual({ reserved_units: paid ? 20 : 100, spent_units: paid ? 12 : 0,
      overrun_units: 0, bills: Number(paid), settlements: Number(paid), receipts: paid ? 2 : 1 });
    expect(state.coverage).toMatchObject({ admitted: 2, missingEvidence: 1, pendingBilling: Number(!paid),
      attributedSettlements: Number(paid) });
    expect(state.recovery).toMatchObject({ jobReference: { jobId }, observation: { state: "cancelled" } });
    expect(state.bill.state).toBe(paid ? "settled" : "pending-bill");
    const access = ro(restored);
    const bundle = await exportSettledEvidence(access,intentId,audience);
    await expect(readDelegatedBilling(access,"other",intentId)).rejects.toThrow("claim unavailable");
    expect(await exportSettledEvidence({ ...access,tenantId:"other" },intentId,audience)).toBeNull();
    if (!paid) expect(bundle).toBeNull();
    else {
      if (!bundle) throw new Error("Restore lost settled export");
      const bytes = Buffer.from(bundle.json);
      expect(bytes.equals(await readFile(retained("original.json")))).toBe(true);
      const pin = retained("original.sha256");
      expect(bundle.digest).toBe(await readFile(pin,"utf8"));
      const path = join(dir,"restored-export.json");
      await writeFile(path,bytes,{ flag: "wx" });
      const { stdout } = await verify(path,"t",intentId,pin,"--audience",audience);
      expect(JSON.parse(stdout)).toMatchObject({ consistent: true, issuerAuthenticated: false, actualMicroUsd: 12,
        outcome: "cancelled", digest: bundle.digest, delegation: { audience } });
      await expect(verify(path,"t",intentId,pin,"--audience","other")).rejects.toMatchObject({
        code: 1, stdout: "", stderr: expect.stringContaining("scope mismatch")
      });
    }
    expect(sha(await readFile(restored))).toBe(before);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  }, 30_000);
});
