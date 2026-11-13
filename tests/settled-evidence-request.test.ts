import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { delegationFixture } from "./fixtures/delegation";
import type { CancellationFixture } from "./fixtures/delegated-cancellation-cases";
import { jobDatabase, jobSqlite } from "./fixtures/job-sqlite";
import { evidenceRequest, settleEvidenceFixture, settledEvidenceRequestCases } from "./fixtures/settled-evidence-request-cases";
import { recoveryCookie, recoveryEnv } from "./fixtures/delegated-recovery-request-cases";
import { requestSettledEvidence } from "../lib/settled-evidence-request";
import { settledEvidenceMcpCases } from "./fixtures/settled-evidence-mcp-cases";

let dir: string, file: string, baseline: string, enrolled: CryptoKeyPair, f: CancellationFixture;
const fixture = delegationFixture(() => file, () => enrolled), { db, sql, first } = fixture;
describe("settled evidence HTTP storage boundary", { timeout: 30000 }, () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "odap-evidence-read-")); file = baseline = join(dir, "claimed.db");
    enrolled = await fixture.keys();
    const job = await fixture.seedAmbiguousDelegation(async () => {});
    f = { ...job, owner: { db, tenantId: "t", principalId: "google:operator" }, audience: "test-gateway", sql, first, revoke: fixture.revoke };
  }, 60000);
  beforeEach(async () => {
    file = join(dir, crypto.randomUUID()+".db"); await copyFile(baseline, file);
    await jobSqlite(file, "apply-delegated-observations"); await jobSqlite(file, "apply-delegated-billing");
  });
  afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });
  settledEvidenceRequestCases(() => f);
  settledEvidenceMcpCases(() => f);
  it("exports schema 0026 through a read-only connection without changing its bytes", async () => {
    await settleEvidenceFixture(f);
    const cookie = await recoveryCookie(), before = await readFile(file);
    const result = await requestSettledEvidence(evidenceRequest(cookie, f.intentId),
      recoveryEnv(jobDatabase(() => file, "readonly")), "t", f.intentId);
    expect(result.status).toBe(200); expect(await readFile(file)).toEqual(before);
  });
  it("refuses old storage after authentication without initializing or migrating it", async () => {
    file = join(dir, crypto.randomUUID()+".db"); await copyFile(baseline, file);
    const before = await readFile(file), env = recoveryEnv(jobDatabase(() => file, "readonly"));
    expect((await requestSettledEvidence(evidenceRequest(await recoveryCookie("reader"), f.intentId), env, "t", f.intentId)).status).toBe(403);
    expect(await requestSettledEvidence(evidenceRequest(await recoveryCookie(), f.intentId), env, "t", f.intentId))
      .toEqual({ status: 503, body: { ok: false, code: "control_storage_unavailable" } });
    expect(await readFile(file)).toEqual(before);
  });
});
