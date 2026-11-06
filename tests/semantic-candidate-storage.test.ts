import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalControlJson, sha256Text } from "../lib/control-objects";
import type { D1Value } from "../lib/d1";
import { approveSemanticRevision, proposeSemanticRevision, recordSemanticValidation } from "../lib/semantic-candidate-storage";
import { jobDatabase, jobSqlite } from "./fixtures/job-sqlite";
import metric from "./fixtures/revenue-metric.json";

let dir: string;
const sqlite = (mode: string, sql = "", params: D1Value[] = []) => jobSqlite(join(dir, "store.db"), mode, sql, params);
const db = jobDatabase(() => join(dir, "store.db"));
const access = (principalId: string, tenantId = "t") => ({ db, tenantId, principalId });
const proposal = { revisionId: "rev", ownerId: "owner", provenanceRef: "fixture:extract-7", definitionJson: JSON.stringify(metric) };
const owner = access("owner"), reviewer = access("reviewer");

describe("durable candidate review, before release", () => {
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "odap-candidate-"));
    await sqlite("setup");
    await sqlite("run", "INSERT INTO control_memberships VALUES ('t','reviewer','reviewer',1),('t','second','owner',1)");
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("adds the new tables to a populated v12 store without certifying its existing release", async () => {
    const file = join(dir, "legacy.db");
    await jobSqlite(file, "setup-v12");
    const release = "SELECT payload,created_by,created_at FROM semantic_releases WHERE tenant_id='t' AND id='r'";
    const before = await jobSqlite(file, "readonly-first", release);
    expect(before?.created_by).toBe("owner");
    await jobSqlite(file, "apply-semantic-revisions");
    expect(await jobSqlite(file, "readonly-first", release)).toEqual(before);
    expect(await jobSqlite(file, "readonly-first", `SELECT
      (SELECT COUNT(*) FROM semantic_candidate_revisions) AS revisions,
      (SELECT COUNT(*) FROM semantic_candidate_validations) AS validations`)).toEqual({ revisions: 0, validations: 0 });
    expect(await jobSqlite(file, "readonly-first", "PRAGMA foreign_key_check")).toBeNull();
  });

  it("persists canonical content, provenance and the named owner's evidence without issuing a release", async () => {
    const revision = await proposeSemanticRevision(reviewer, proposal);
    expect(revision.definitionDigest).toBe(await sha256Text(canonicalControlJson(metric)));
    await recordSemanticValidation(owner, revision.revisionId, revision.definitionDigest, "fixture:review-21");
    expect(await sqlite("readonly-first", `SELECT r.definition_json,r.proposed_by,r.provenance_ref,
      v.validated_by,v.definition_digest,v.evidence_ref FROM semantic_candidate_revisions r
      JOIN semantic_candidate_validations v ON v.tenant_id=r.tenant_id AND v.revision_id=r.id`))
      .toEqual({ definition_json: canonicalControlJson(metric), proposed_by: "reviewer", provenance_ref: proposal.provenanceRef,
        validated_by: "owner", definition_digest: revision.definitionDigest, evidence_ref: "fixture:review-21" });
    expect(await sqlite("first", "SELECT group_concat(id) AS ids FROM semantic_releases")).toEqual({ ids: "r" });
  });

  it("rejects unauthorized proposals, forged tenant content, a foreign owner and missing provenance", async () => {
    await expect(proposeSemanticRevision(access("user"), proposal)).rejects.toThrow("not recorded");
    await expect(proposeSemanticRevision(reviewer, { ...proposal, ownerId: "user" })).rejects.toThrow("not recorded");
    await sqlite("run", "INSERT INTO control_tenants VALUES('peer','Peer')");
    await sqlite("run", "INSERT INTO control_memberships VALUES('peer','foreign','owner',1)");
    await expect(proposeSemanticRevision(reviewer, { ...proposal, ownerId: "foreign" })).rejects.toThrow("not recorded");
    await expect(proposeSemanticRevision(access("foreign", "peer"), proposal)).rejects.toThrow("scope");
    await expect(proposeSemanticRevision(reviewer, { ...proposal, provenanceRef: " " })).rejects.toThrow();
    expect(await sqlite("first", "SELECT count(*) AS n FROM semantic_candidate_revisions")).toEqual({ n: 0 });
  });

  it("rechecks current named ownership and refuses a digest from a different revision", async () => {
    const old = await proposeSemanticRevision(reviewer, proposal);
    const changed = { ...proposal, definitionJson: JSON.stringify({ ...metric, sourceRevision: "s2" }) };
    await expect(proposeSemanticRevision(reviewer, changed)).rejects.toThrow("not recorded");
    const next = await proposeSemanticRevision(reviewer, { ...changed, revisionId: "rev2" });
    expect(next.definitionDigest).not.toBe(old.definitionDigest);
    await expect(recordSemanticValidation(owner, "rev2", old.definitionDigest, "stale")).rejects.toThrow("not recorded");
    for (const caller of [reviewer, access("second"), access("owner", "peer")]) {
      await expect(recordSemanticValidation(caller, "rev", old.definitionDigest, "other")).rejects.toThrow("not recorded");
    }
    await sqlite("run", "UPDATE control_memberships SET active=0 WHERE tenant_id='t' AND principal_id='owner'");
    await expect(recordSemanticValidation(owner, "rev", old.definitionDigest, "revoked")).rejects.toThrow("not recorded");
    expect(await sqlite("first", "SELECT count(*) AS n FROM semantic_candidate_validations")).toEqual({ n: 0 });
  });

  it("retains exactly the winning evidence under competing validations, even after a replacement attempt", async () => {
    const { definitionDigest } = await proposeSemanticRevision(reviewer, proposal);
    const refs = ["check:first", "check:second"];
    const results = await Promise.allSettled(refs.map(ref => recordSemanticValidation(owner, "rev", definitionDigest, ref)));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const winning = refs[results.findIndex(result => result.status === "fulfilled")];
    await sqlite("run", `INSERT OR REPLACE INTO semantic_candidate_validations
      (tenant_id,revision_id,definition_digest,validated_by,evidence_ref)
      SELECT tenant_id,revision_id,definition_digest,validated_by,'changed' FROM semantic_candidate_validations`);
    await expect(sqlite("run", "UPDATE semantic_candidate_revisions SET provenance_ref='changed'")).rejects.toThrow();
    await expect(sqlite("run", "DELETE FROM semantic_candidate_validations")).rejects.toThrow();
    expect(await sqlite("readonly-first", "SELECT count(*) AS n, min(evidence_ref) AS ref FROM semantic_candidate_validations"))
      .toEqual({ n: 1, ref: winning });
  });

  const approval = { approvalId: "dec-1", revisionId: "rev", evidenceRef: "check:net-revenue" };
  const approvalCount = () => sqlite("readonly-first", "SELECT count(*) AS n FROM semantic_candidate_approvals");

  it("upgrades a validated v13 revision without approving it, then retains the owner's explicit decision", async () => {
    const file = join(dir, "legacy.db");
    const legacy = { ...owner, db: jobDatabase(() => file) };
    await jobSqlite(file, "setup-v12");
    await jobSqlite(file, "apply-semantic-revisions");
    const { definitionDigest } = await proposeSemanticRevision(legacy, proposal);
    await recordSemanticValidation(legacy, "rev", definitionDigest, approval.evidenceRef);
    await jobSqlite(file, "apply-semantic-approvals");
    expect(await jobSqlite(file, "readonly-first", "SELECT count(*) AS n FROM semantic_candidate_approvals")).toEqual({ n: 0 });
    await expect(approveSemanticRevision(legacy, { ...approval, reviewedDigest: definitionDigest }))
      .resolves.toEqual({ approvalId: "dec-1", revisionId: "rev" });
    const row = await jobSqlite(file, "readonly-first", `SELECT a.id,a.approved_at,a.approved_by,v.definition_digest,v.evidence_ref
      FROM semantic_candidate_approvals a JOIN semantic_candidate_validations v USING(tenant_id,revision_id)`);
    expect(row).toEqual({ id: "dec-1", approved_at: expect.stringMatching(/^\d{4}-.*Z$/), approved_by: "owner",
      definition_digest: definitionDigest, evidence_ref: approval.evidenceRef });
    expect(await jobSqlite(file, "readonly-first", "SELECT group_concat(id) AS ids FROM semantic_releases")).toEqual({ ids: "r" });
    expect(await jobSqlite(file, "readonly-first", "PRAGMA foreign_key_check")).toBeNull();
  });

  it("denies missing validation, substituted evidence and prior-version digests", async () => {
    const old = await proposeSemanticRevision(reviewer, proposal);
    const input = { ...approval, reviewedDigest: old.definitionDigest };
    await expect(approveSemanticRevision(owner, input)).rejects.toThrow("not recorded");
    await recordSemanticValidation(owner, "rev", old.definitionDigest, approval.evidenceRef);
    await expect(approveSemanticRevision(owner, { ...input, evidenceRef: "check:other" })).rejects.toThrow("not recorded");
    const next = await proposeSemanticRevision(reviewer, { ...proposal, revisionId: "rev2",
      definitionJson: JSON.stringify({ ...metric, sourceRevision: "s2" }) });
    await recordSemanticValidation(owner, "rev2", next.definitionDigest, approval.evidenceRef);
    await expect(approveSemanticRevision(owner, { ...input, revisionId: "rev2" })).rejects.toThrow("not recorded");
    expect(await approvalCount()).toEqual({ n: 0 });
  });

  it.each(["peer", "reviewer", "second", "demoted", "inactive"] as const)(
    "rejects %s approval without borrowing the identically named peer revision", async actor => {
    const { definitionDigest } = await proposeSemanticRevision(reviewer, proposal);
    await recordSemanticValidation(owner, "rev", definitionDigest, approval.evidenceRef);
    const input = { ...approval, reviewedDigest: definitionDigest };
    await sqlite("run", "INSERT INTO control_tenants VALUES('peer','Peer')");
    await sqlite("run", "INSERT INTO control_memberships VALUES('peer','owner','owner',1)");
    const peer = access("owner", "peer");
    const peerRevision = await proposeSemanticRevision(peer, { ...proposal,
      definitionJson: JSON.stringify({ ...metric, tenantId: "peer" }) });
    await recordSemanticValidation(peer, "rev", peerRevision.definitionDigest, approval.evidenceRef);
    if (actor === "demoted")
      await sqlite("run", "UPDATE control_memberships SET role='reviewer' WHERE tenant_id='t' AND principal_id='owner'");
    if (actor === "inactive")
      await sqlite("run", "UPDATE control_memberships SET active=0 WHERE tenant_id='t' AND principal_id='owner'");
    const caller = actor === "peer" ? peer : actor === "reviewer" ? reviewer : actor === "second" ? access("second") : owner;
    await expect(approveSemanticRevision(caller, input)).rejects.toThrow("not recorded");
    expect(await approvalCount()).toEqual({ n: 0 });
    await approveSemanticRevision(peer, { ...input, reviewedDigest: peerRevision.definitionDigest });
    expect(await sqlite("readonly-first", "SELECT tenant_id FROM semantic_candidate_approvals")).toEqual({ tenant_id: "peer" });
  });

  it("commits one distinct decision per revision and never rebinds its ID to another revision", async () => {
    const { definitionDigest } = await proposeSemanticRevision(reviewer, proposal);
    const input = { ...approval, reviewedDigest: definitionDigest };
    await recordSemanticValidation(owner, "rev", definitionDigest, approval.evidenceRef);
    const ids = ["dec-left", "dec-right"];
    const outcomes = await Promise.allSettled(ids.map(approvalId => approveSemanticRevision(owner, { ...input, approvalId })));
    expect(outcomes.filter(o => o.status === "fulfilled")).toHaveLength(1);
    const winner = ids[outcomes.findIndex(o => o.status === "fulfilled")];
    await proposeSemanticRevision(reviewer, { ...proposal, revisionId: "rev2" });
    await recordSemanticValidation(owner, "rev2", definitionDigest, approval.evidenceRef);
    await expect(approveSemanticRevision(owner, { ...input, revisionId: "rev2", approvalId: winner })).rejects.toThrow("not recorded");
    await sqlite("run", `INSERT OR REPLACE INTO semantic_candidate_approvals(tenant_id,id,revision_id,approved_by)
      VALUES('t',?,'rev2','owner')`, [winner]);
    await expect(sqlite("run", "UPDATE semantic_candidate_approvals SET revision_id='rev2'")).rejects.toThrow();
    await expect(sqlite("run", "DELETE FROM semantic_candidate_approvals")).rejects.toThrow();
    expect(await approvalCount()).toEqual({ n: 1 });
    expect(await sqlite("readonly-first", "SELECT id,revision_id FROM semantic_candidate_approvals"))
      .toEqual({ id: winner, revision_id: "rev" });
  });
});
