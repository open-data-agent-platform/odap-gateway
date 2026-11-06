import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readControlObject } from "../lib/control-storage";
import type { D1Value } from "../lib/d1";
import { approveSemanticRevision, promoteSemanticRevision, proposeSemanticRevision,
  recordSemanticValidation, retireSemanticRelease, withdrawSemanticApproval } from "../lib/semantic-candidate-storage";
import { jobDatabase, jobSqlite } from "./fixtures/job-sqlite";
import metric from "./fixtures/revenue-metric.json";

let dir: string, digest: string;
const file = () => join(dir, "promotion.db");
const sql = (mode: string, statement = "", params: D1Value[] = []) => jobSqlite(file(), mode, statement, params);
const owner = { db: jobDatabase(file), tenantId: "t", principalId: "owner" };
const input = { revisionId: "rev", approvalId: "dec", releaseId: "new" };
const head = () => sql("run", "INSERT INTO semantic_source_heads VALUES ('t','orders','demo-project','analytics','orders','s1')");
const counts = () => sql("readonly-first", `SELECT
  (SELECT count(*) FROM semantic_release_promotions) AS links,
  (SELECT count(*) FROM semantic_releases WHERE id<>'r') AS releases,
  (SELECT count(*) FROM control_object_events WHERE object_kind='release' AND object_id<>'r') AS events`);
const none = { links: 0, releases: 0, events: 0 };
const one = { links: 1, releases: 1, events: 1 };
const withdrawal = { approvalId: input.approvalId, revisionId: input.revisionId, reason: "fixture:correct-definition" };
const withdrawalCounts = () => sql("readonly-first", `SELECT
  (SELECT count(*) FROM semantic_approval_withdrawals) AS withdrawals,
  (SELECT count(*) FROM control_object_events WHERE object_kind='semantic_approval_withdrawal') AS events`);

describe("local promotion of an approved semantic revision", () => {
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "odap-promotion-"));
    await sql("setup-v14");
    const proposed = await proposeSemanticRevision(owner, { revisionId: "rev", ownerId: "owner",
      provenanceRef: "fixture:catalog", definitionJson: JSON.stringify(metric) });
    digest = proposed.definitionDigest;
    await recordSemanticValidation(owner, "rev", digest, "fixture:review");
    await approveSemanticRevision(owner, { ...input, reviewedDigest: digest, evidenceRef: "fixture:review" });
    await sql("apply-semantic-promotion");
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("upgrades without backfill and issues precisely one readable release under contention", async () => {
    expect(await counts()).toEqual(none);
    expect(await sql("readonly-first", "SELECT count(*) AS n FROM semantic_source_heads")).toEqual({ n: 0 });
    await head();
    const contenders = ["new-a", "new-b"];
    const results = await Promise.allSettled(contenders.map(releaseId => promoteSemanticRevision(owner, { ...input, releaseId })));
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    const i = results.findIndex(r => r.status === "fulfilled"), id = contenders[i];
    expect(results[i]).toEqual({ status: "fulfilled", value: { releaseId: id } });
    expect(await counts()).toEqual(one);
    expect(await readControlObject(owner, "release", id)).toEqual({ id, tenantId: "t", owner: "owner", schemaVersion: "0.1",
      definitionDigest: digest, sourceRevision: "s1", state: "released" });
    expect(await sql("readonly-first", `SELECT p.release_id,p.approval_id,r.provenance_ref,v.evidence_ref,p.promoted_by
      FROM semantic_release_promotions p JOIN semantic_candidate_approvals a ON a.tenant_id=p.tenant_id AND a.id=p.approval_id
      JOIN semantic_candidate_revisions r ON r.tenant_id=a.tenant_id AND r.id=a.revision_id
      JOIN semantic_candidate_validations v ON v.tenant_id=r.tenant_id AND v.revision_id=r.id`))
      .toEqual({ release_id: id, approval_id: "dec", provenance_ref: "fixture:catalog", evidence_ref: "fixture:review", promoted_by: "owner" });
    expect(await sql("readonly-first", "SELECT count(*) AS n FROM dispatch_targets")).toEqual({ n: 0 });
    expect(await sql("readonly-first", "PRAGMA foreign_key_check")).toBeNull();
  });

  it("denies missing or changed catalog authority, including a redirected table at the same revision", async () => {
    await expect(promoteSemanticRevision(owner, input)).rejects.toThrow();
    await head();
    await sql("run", "UPDATE semantic_source_heads SET source_revision='s2'");
    await expect(promoteSemanticRevision(owner, input)).rejects.toThrow();
    await sql("run", "UPDATE semantic_source_heads SET source_revision='s1',table_id='different_orders'");
    await expect(promoteSemanticRevision(owner, input)).rejects.toThrow();
    expect(await counts()).toEqual(none);
  });

  it("rejects substituted revision, tenant or approver and owner demotion or deactivation after approval", async () => {
    await head();
    await sql("run", "INSERT INTO control_tenants VALUES ('peer','Peer')");
    await sql("run", "INSERT INTO control_memberships VALUES ('peer','owner','owner',1),('t','other','owner',1)");
    await expect(promoteSemanticRevision({ ...owner, tenantId: "peer" }, input)).rejects.toThrow();
    await expect(promoteSemanticRevision({ ...owner, principalId: "other" }, input)).rejects.toThrow();
    await expect(promoteSemanticRevision(owner, { ...input, revisionId: "another" })).rejects.toThrow();
    await sql("run", "UPDATE control_memberships SET role='reader' WHERE tenant_id='t' AND principal_id='owner'");
    await expect(promoteSemanticRevision(owner, input)).rejects.toThrow();
    await sql("run", "UPDATE control_memberships SET role='owner',active=0 WHERE tenant_id='t' AND principal_id='owner'");
    await expect(promoteSemanticRevision(owner, input)).rejects.toThrow();
    expect(await counts()).toEqual(none);
  });

  it("rolls back even the promotion link when the audit write fails, allowing a clean retry", async () => {
    await head();
    await sql("run", `CREATE TRIGGER fail_test_audit BEFORE INSERT ON control_object_events
      BEGIN SELECT RAISE(ABORT,'test audit unavailable'); END`);
    await expect(promoteSemanticRevision(owner, input)).rejects.toThrow("test audit unavailable");
    expect(await counts()).toEqual(none);
    await sql("run", "DROP TRIGGER fail_test_audit");
    await expect(promoteSemanticRevision(owner, input)).resolves.toEqual({ releaseId: "new" });
    expect(await counts()).toEqual(one);
  });

  it("cannot adopt a legacy release or replace the newly issued release or its approval link", async () => {
    await head();
    await expect(promoteSemanticRevision(owner, { ...input, releaseId: "r" })).rejects.toThrow();
    expect(await counts()).toEqual(none);
    await promoteSemanticRevision(owner, input);
    await expect(sql("run", `INSERT OR REPLACE INTO semantic_releases(tenant_id,id,payload,created_by)
      SELECT tenant_id,id,json_set(payload,'$.sourceRevision','forged'),created_by FROM semantic_releases WHERE id='new'`))
      .rejects.toThrow("immutable promoted release");
    await expect(sql("run", `INSERT OR REPLACE INTO semantic_release_promotions
      VALUES('t','dec','rev','forged','owner')`)).rejects.toThrow();
    expect(await counts()).toEqual(one);
    expect(await readControlObject(owner, "release", "new")).toMatchObject({ sourceRevision: "s1", definitionDigest: digest });
  });

  it("recognizes publication before migration without backfilling a withdrawal or retiring the release", async () => {
    await head();
    await promoteSemanticRevision(owner, input);
    await sql("apply-semantic-withdrawal");
    await expect(withdrawSemanticApproval(owner, withdrawal)).resolves.toEqual({ status: "already_promoted", releaseId: "new" });
    expect(await withdrawalCounts()).toEqual({ withdrawals: 0, events: 0 });
    expect(await counts()).toEqual(one);
    expect(await sql("readonly-first", "SELECT count(*) AS n FROM dispatch_retired_releases")).toEqual({ n: 0 });
    expect(await sql("readonly-first", "PRAGMA foreign_key_check")).toBeNull();
  });

  it("retires an issued release only for its active named owner, preserving its bytes and review chain", async () => {
    await sql("apply-semantic-withdrawal");
    await sql("apply-semantic-retirement");
    await head();
    await promoteSemanticRevision(owner, input);
    const original = await sql("readonly-first", "SELECT * FROM semantic_releases WHERE id='new'");
    await sql("run", "INSERT INTO control_tenants VALUES('peer','Peer')");
    await sql("run", "INSERT INTO control_memberships VALUES('peer','owner','owner',1),('t','other','owner',1)");
    for (const actor of [{ ...owner, tenantId: "peer" }, { ...owner, principalId: "other" }]) {
      await expect(retireSemanticRelease(actor, "new", "test")).rejects.toThrow("unavailable");
    }
    await sql("run", "UPDATE control_memberships SET active=0 WHERE principal_id='owner' AND tenant_id='t'");
    await expect(retireSemanticRelease(owner, "new", "test")).rejects.toThrow("unavailable");
    await sql("run", "UPDATE control_memberships SET active=1 WHERE principal_id='owner' AND tenant_id='t'");
    expect(await sql("first", "SELECT count(*) AS n FROM dispatch_retired_releases")).toEqual({ n: 0 });
    await sql("run", `CREATE TRIGGER fail_retirement_audit BEFORE INSERT ON control_object_events
      WHEN NEW.object_kind='semantic_release_retirement' BEGIN SELECT RAISE(ABORT,'test audit unavailable'); END`);
    await expect(retireSemanticRelease(owner, "new", "test")).rejects.toThrow("test audit unavailable");
    expect(await sql("first", "SELECT count(*) AS n FROM dispatch_retired_releases")).toEqual({ n: 0 });
    await sql("run", "DROP TRIGGER fail_retirement_audit");
    expect(await retireSemanticRelease(owner, "new", "review superseded")).toMatchObject({ status: "retired" });
    await expect(sql("run", "DELETE FROM dispatch_retired_releases")).rejects.toThrow("immutable");
    await expect(sql("run", "UPDATE dispatch_retired_releases SET reason='changed'")).rejects.toThrow("immutable");
    await expect(retireSemanticRelease({ ...owner, principalId: "other" }, "new", "retry")).rejects.toThrow("unavailable");
    expect(await sql("readonly-first", "SELECT * FROM semantic_releases WHERE id='new'")).toEqual(original);
    expect(await counts()).toEqual(one);
    expect(await withdrawalCounts()).toEqual({ withdrawals: 0, events: 0 });
  }, 20_000);

  describe("approval withdrawal", () => {
    beforeEach(async () => { await sql("apply-semantic-withdrawal"); });

    it("retains the first reason, actor and time; no later publication or retry overwrites the facts", async () => {
      const approvalBefore = await sql("readonly-first", "SELECT * FROM semantic_candidate_approvals");
      const result = await withdrawSemanticApproval(owner, withdrawal);
      if (result.status !== "withdrawn") throw new Error("First withdrawal not recorded");
      await head();
      await expect(promoteSemanticRevision(owner, input)).rejects.toThrow("semantic promotion unavailable");
      await expect(withdrawSemanticApproval(owner, { ...withdrawal, reason: "replacement" }))
        .resolves.toEqual({ status: "already_withdrawn", withdrawnAt: result.withdrawnAt });
      await sql("run", `INSERT OR REPLACE INTO semantic_approval_withdrawals
        (tenant_id,approval_id,revision_id,withdrawn_by,reason) VALUES('t','dec','rev','owner','changed')`);
      await expect(sql("run", "UPDATE semantic_approval_withdrawals SET reason='changed'")).rejects.toThrow();
      await expect(sql("run", "DELETE FROM semantic_approval_withdrawals")).rejects.toThrow();
      expect(await sql("readonly-first", "SELECT * FROM semantic_approval_withdrawals")).toEqual({
        tenant_id: "t", approval_id: "dec", revision_id: "rev", withdrawn_by: "owner",
        reason: withdrawal.reason, withdrawn_at: result.withdrawnAt
      });
      expect(await sql("readonly-first", "SELECT * FROM semantic_candidate_approvals")).toEqual(approvalBefore);
      expect(await counts()).toEqual(none);
      expect(await withdrawalCounts()).toEqual({ withdrawals: 1, events: 1 });
    });

    it("allows only the current approving owner to withdraw or inspect the terminal result", async () => {
      await sql("run", "INSERT INTO control_tenants VALUES('peer','Peer')");
      await sql("run", "INSERT INTO control_memberships VALUES('peer','owner','owner',1),('t','other','owner',1)");
      const peer = { ...owner, tenantId: "peer" }, other = { ...owner, principalId: "other" };
      for (const caller of [other, peer]) {
        await expect(withdrawSemanticApproval(caller, withdrawal)).rejects.toThrow("unavailable");
      }
      await expect(withdrawSemanticApproval(owner, { ...withdrawal, revisionId: "different" })).rejects.toThrow("unavailable");
      await expect(withdrawSemanticApproval(owner, { ...withdrawal, reason: " " })).rejects.toThrow("Invalid");
      await sql("run", "UPDATE control_memberships SET active=0 WHERE principal_id='owner' AND tenant_id='t'");
      await expect(withdrawSemanticApproval(owner, withdrawal)).rejects.toThrow("unavailable");
      expect(await withdrawalCounts()).toEqual({ withdrawals: 0, events: 0 });
      await sql("run", "UPDATE control_memberships SET active=1 WHERE principal_id='owner' AND tenant_id='t'");
      await head();
      await promoteSemanticRevision(owner, input);
      await sql("run", "UPDATE control_memberships SET role='reader' WHERE principal_id='owner' AND tenant_id='t'");
      for (const caller of [owner, other, peer]) {
        await expect(withdrawSemanticApproval(caller, withdrawal)).rejects.toThrow("unavailable");
      }
    });

    it("commits precisely one outcome when withdrawal races publication on independent connections", async () => {
      await head();
      const [w, p] = await Promise.allSettled([withdrawSemanticApproval(owner, withdrawal), promoteSemanticRevision(owner, input)]);
      if (w.status !== "fulfilled") throw w.reason;
      if (w.value.status === "withdrawn") {
        expect(p.status).toBe("rejected");
        expect(await counts()).toEqual(none);
        expect(await withdrawalCounts()).toEqual({ withdrawals: 1, events: 1 });
      } else {
        expect(w.value).toEqual({ status: "already_promoted", releaseId: "new" });
        expect(p).toEqual({ status: "fulfilled", value: { releaseId: "new" } });
        expect(await counts()).toEqual(one);
        expect(await withdrawalCounts()).toEqual({ withdrawals: 0, events: 0 });
      }
    });

    it("does not block another tenant's identically named approval and revision", async () => {
      await sql("run", "INSERT INTO control_tenants VALUES('peer','Peer')");
      await sql("run", "INSERT INTO control_memberships VALUES('peer','owner','owner',1)");
      const peer = { ...owner, tenantId: "peer" };
      const rev = await proposeSemanticRevision(peer, { ...input, ownerId: "owner", provenanceRef: "fixture:peer",
        definitionJson: JSON.stringify({ ...metric, tenantId: "peer" }) });
      await recordSemanticValidation(peer, input.revisionId, rev.definitionDigest, "fixture:review");
      await approveSemanticRevision(peer, { ...input, reviewedDigest: rev.definitionDigest, evidenceRef: "fixture:review" });
      await sql("run", "INSERT INTO semantic_source_heads VALUES('peer','orders','demo-project','analytics','orders','s1')");
      await expect(withdrawSemanticApproval(owner, withdrawal)).resolves.toMatchObject({ status: "withdrawn" });
      await expect(promoteSemanticRevision(peer, input)).resolves.toEqual({ releaseId: "new" });
      await expect(withdrawSemanticApproval(peer, withdrawal)).resolves.toEqual({ status: "already_promoted", releaseId: "new" });
      expect(await sql("readonly-first", "SELECT tenant_id FROM semantic_approval_withdrawals")).toEqual({ tenant_id: "t" });
      expect(await sql("readonly-first", "SELECT tenant_id FROM semantic_release_promotions")).toEqual({ tenant_id: "peer" });
    });

    it("rolls back withdrawal on audit failure without blocking publication", async () => {
      await sql("run", `CREATE TRIGGER fail_withdrawal_audit BEFORE INSERT ON control_object_events
        WHEN NEW.object_kind='semantic_approval_withdrawal' BEGIN SELECT RAISE(ABORT,'test audit unavailable'); END`);
      await expect(withdrawSemanticApproval(owner, withdrawal)).rejects.toThrow("test audit unavailable");
      expect(await withdrawalCounts()).toEqual({ withdrawals: 0, events: 0 });
      await head();
      await expect(promoteSemanticRevision(owner, input)).resolves.toEqual({ releaseId: "new" });
      expect(await counts()).toEqual(one);
    });
  });
});
