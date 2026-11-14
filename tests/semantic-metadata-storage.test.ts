import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareSemanticMetadataImport, recordSemanticMetadataProposal } from "../lib/semantic-metadata-import";
import { approveSemanticRevision, promoteSemanticRevision } from "../lib/semantic-candidate-storage";
import { readSemanticReview } from "../lib/semantic-review";
import { jobDatabase, jobSqlite } from "./fixtures/job-sqlite";
import { metadataMapping, metadataSource } from "./fixtures/semantic-metadata";

describe.each(["cube", "dbt"] as const)("%s metadata uses existing candidate admission", kind => {
  let dir: string;
  const sqlite = (mode: string, sql = "") => jobSqlite(join(dir, "store.db"), mode, sql);
  const db = jobDatabase(() => join(dir, "store.db"));
  const reviewer = { db, tenantId: "t", principalId: "reviewer" };
  const bundle = () => prepareSemanticMetadataImport(JSON.stringify(metadataSource(kind)), JSON.stringify(metadataMapping(kind)));

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "odap-metadata-store-"));
    await sqlite("setup");
    await sqlite("run", "INSERT INTO control_memberships VALUES('t','reviewer','reviewer',1)");
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("records only a candidate with provenance and cannot skip validation or approval", async () => {
    const staged = await bundle();
    const releases = await sqlite("readonly-first", "SELECT COUNT(*) AS n FROM semantic_releases");
    await recordSemanticMetadataProposal(reviewer, JSON.stringify(staged), staged.evidenceDigest);
    expect(await readSemanticReview(reviewer, staged.proposal.revisionId)).toMatchObject({ state: "candidate", releaseId: null, approvalId: null });
    expect(await sqlite("readonly-first", "SELECT provenance_ref,owner_id,proposed_by FROM semantic_candidate_revisions"))
      .toEqual({ provenance_ref: staged.proposal.provenanceRef, owner_id: "owner", proposed_by: "reviewer" });
    expect(await sqlite("readonly-first", `SELECT
      (SELECT COUNT(*) FROM semantic_candidate_validations) AS validations,
      (SELECT COUNT(*) FROM semantic_candidate_approvals) AS approvals,
      (SELECT COUNT(*) FROM semantic_release_promotions) AS promotions`)).toEqual({ validations: 0, approvals: 0, promotions: 0 });
    expect(await sqlite("readonly-first", "SELECT COUNT(*) AS n FROM semantic_releases")).toEqual(releases);
    const owner = { ...reviewer, principalId: "owner" };
    await expect(approveSemanticRevision(owner, { approvalId: "no-auto-approval", revisionId: staged.proposal.revisionId,
      reviewedDigest: "sha256:" + "0".repeat(64), evidenceRef: staged.proposal.provenanceRef })).rejects.toThrow();
    await expect(promoteSemanticRevision(owner, { approvalId: "no-auto-approval", revisionId: staged.proposal.revisionId,
      releaseId: "no-auto-release" })).rejects.toThrow();
  });

  it("does not promote upstream owners, inactive reviewers or inactive local owners to authority", async () => {
    const staged = await bundle();
    await expect(recordSemanticMetadataProposal({ ...reviewer, principalId: "upstream-owner" },
      JSON.stringify(staged), staged.evidenceDigest)).rejects.toThrow();
    await sqlite("run", "UPDATE control_memberships SET active=0 WHERE principal_id='reviewer'");
    await expect(recordSemanticMetadataProposal(reviewer, JSON.stringify(staged), staged.evidenceDigest)).rejects.toThrow();
    await sqlite("run", "UPDATE control_memberships SET active=1 WHERE principal_id='reviewer'");
    await sqlite("run", "UPDATE control_memberships SET active=0 WHERE principal_id='owner'");
    await expect(recordSemanticMetadataProposal(reviewer, JSON.stringify(staged), staged.evidenceDigest)).rejects.toThrow();
    expect(await sqlite("readonly-first", "SELECT COUNT(*) AS n FROM semantic_candidate_revisions")).toEqual({ n: 0 });
  });

  it("rejects foreign tenant and altered evidence before accessing storage", async () => {
    const staged = await bundle();
    const trapped = { ...reviewer, db: { ...db, prepare() { throw new Error("Unexpected storage access"); } } };
    await expect(recordSemanticMetadataProposal({ ...trapped, tenantId: "peer" }, JSON.stringify(staged), staged.evidenceDigest))
      .rejects.toThrow("tenant mismatch");
    await expect(recordSemanticMetadataProposal(trapped, JSON.stringify({ ...staged, proposal: { ...staged.proposal, ownerId: "other" } }), staged.evidenceDigest))
      .rejects.toThrow("bundle mismatch");
  });

  it("keeps the original immutable revision when a changed export is reimported", async () => {
    const first = await bundle();
    await recordSemanticMetadataProposal(reviewer, JSON.stringify(first), first.evidenceDigest);
    const changed = await prepareSemanticMetadataImport(JSON.stringify({ ...metadataSource(kind), description: "changed context" }), JSON.stringify(metadataMapping(kind)));
    await expect(recordSemanticMetadataProposal(reviewer, JSON.stringify(changed), changed.evidenceDigest)).rejects.toThrow();
    expect(await sqlite("readonly-first", "SELECT COUNT(*) AS n,MIN(provenance_ref) AS ref FROM semantic_candidate_revisions"))
      .toEqual({ n: 1, ref: first.proposal.provenanceRef });
  });
});
