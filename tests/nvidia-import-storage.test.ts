import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareNvidiaSemanticImport, recordNvidiaSemanticProposal } from "../lib/nvidia-semantic-import";
import { readSemanticReview } from "../lib/semantic-review";
import { approveSemanticRevision, promoteSemanticRevision } from "../lib/semantic-candidate-storage";
import { jobDatabase, jobSqlite } from "./fixtures/job-sqlite";
import { nvidiaMapping } from "./fixtures/nvidia-import";
import source from "./fixtures/nvidia-sql-attribute.json";

let dir: string;
const sqlite = (mode: string, sql = "") => jobSqlite(join(dir, "store.db"), mode, sql);
const db = jobDatabase(() => join(dir, "store.db"));
const reviewer = { db, tenantId: "t", principalId: "reviewer" };
const bundle = () => prepareNvidiaSemanticImport(JSON.stringify(source), JSON.stringify(nvidiaMapping()));

describe("NVIDIA import uses existing tenant candidate admission", () => {
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "odap-nvidia-"));
    await sqlite("setup");
    await sqlite("run", "INSERT INTO control_memberships VALUES('t','reviewer','reviewer',1)");
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("records a certified upstream item only as a candidate with durable provenance", async () => {
    const staged = await bundle();
    const releases = await sqlite("readonly-first", "SELECT COUNT(*) AS n FROM semantic_releases");
    await recordNvidiaSemanticProposal(reviewer, JSON.stringify(staged), staged.evidenceDigest);
    expect(await readSemanticReview(reviewer, staged.proposal.revisionId)).toMatchObject({ state: "candidate", releaseId: null, approvalId: null });
    expect(await sqlite("readonly-first", "SELECT provenance_ref,owner_id,proposed_by FROM semantic_candidate_revisions"))
      .toEqual({ provenance_ref: staged.proposal.provenanceRef, owner_id: "owner", proposed_by: "reviewer" });
    expect(await sqlite("readonly-first", `SELECT
      (SELECT COUNT(*) FROM semantic_candidate_validations) AS validations,
      (SELECT COUNT(*) FROM semantic_candidate_approvals) AS approvals,
      (SELECT COUNT(*) FROM semantic_release_promotions) AS promotions`)).toEqual({ validations: 0, approvals: 0, promotions: 0 });
    expect(await sqlite("readonly-first", "SELECT COUNT(*) AS n FROM semantic_releases")).toEqual(releases);
    const owner = { ...reviewer, principalId: "owner" };
    await expect(approveSemanticRevision(owner, { approvalId: "cannot-skip-review", revisionId: staged.proposal.revisionId,
      reviewedDigest: "sha256:" + "0".repeat(64), evidenceRef: staged.proposal.provenanceRef })).rejects.toThrow();
    await expect(promoteSemanticRevision(owner, { approvalId: "cannot-skip-review", revisionId: staged.proposal.revisionId,
      releaseId: "cannot-auto-release" })).rejects.toThrow();
  });

  it("does not map an upstream owner or zone to a local permission", async () => {
    const staged = await bundle();
    await expect(recordNvidiaSemanticProposal({ ...reviewer, principalId: source.data.owner_id },
      JSON.stringify(staged), staged.evidenceDigest)).rejects.toThrow();
    await sqlite("run", "UPDATE control_memberships SET active=0 WHERE principal_id='reviewer'");
    await expect(recordNvidiaSemanticProposal(reviewer, JSON.stringify(staged), staged.evidenceDigest)).rejects.toThrow();
    expect(await sqlite("readonly-first", "SELECT COUNT(*) AS n FROM semantic_candidate_revisions")).toEqual({ n: 0 });
  });

  it("rejects foreign tenant and tampering before touching storage", async () => {
    const staged = await bundle();
    const trapped = { ...reviewer, db: { ...db, prepare() { throw new Error("Unexpected storage access"); } } };
    await expect(recordNvidiaSemanticProposal({ ...trapped, tenantId: "peer" }, JSON.stringify(staged), staged.evidenceDigest))
      .rejects.toThrow("tenant mismatch");
    await expect(recordNvidiaSemanticProposal(trapped, JSON.stringify({ ...staged, proposal: { ...staged.proposal, ownerId: "other" } }), staged.evidenceDigest))
      .rejects.toThrow("bundle mismatch");
  });

  it("retains the original proposal when reimport attempts to overwrite its revision", async () => {
    const first = await bundle();
    await recordNvidiaSemanticProposal(reviewer, JSON.stringify(first), first.evidenceDigest);
    const changed = await prepareNvidiaSemanticImport(JSON.stringify({ data: { ...source.data, certified: false } }), JSON.stringify(nvidiaMapping()));
    await expect(recordNvidiaSemanticProposal(reviewer, JSON.stringify(changed), changed.evidenceDigest)).rejects.toThrow();
    expect(await sqlite("readonly-first", "SELECT COUNT(*) AS n,MIN(provenance_ref) AS ref FROM semantic_candidate_revisions"))
      .toEqual({ n: 1, ref: first.proposal.provenanceRef });
  });
});
