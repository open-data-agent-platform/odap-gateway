import { expect, it } from "vitest";
import type { D1Database } from "../../lib/d1";
import { cancelPostgresRead, claimPostgresRead, inspectPostgresRead, observePostgresRead, postgresCancellationRequested,
  postgresControlCommand, preparePostgresDispatch, stopPostgresRead } from "../../lib/postgresql-control";
import { recordPostgresFailure } from "../../lib/postgresql-terminal";
import { inspectPostgresAgent, verifyPostgresAgent } from "../../lib/postgresql-agent";
import { approvePostgresFixture, pgAccess, pgRun, publishPostgresFixture } from "./postgresql-control";
import { approvePostgresAgentFixture, pgAgentOrigin } from "./postgresql-agent";

export function postgresCancellationCases(getDb: () => D1Database) {
  async function prepare(claim = true) {
    const db = getDb(); await publishPostgresFixture(db); await approvePostgresFixture(db);
    const { row } = await preparePostgresDispatch(pgAccess(db), "request");
    if (claim) await claimPostgresRead(pgAccess(db), row, "one");
    return { db, row };
  }
  it.each(["reader", "owner"])("records %s cancellation without asserting delivery or releasing capacity", async who => {
    const { db } = await prepare();
    expect(await cancelPostgresRead(pgAccess(db, who), "request")).toEqual({ requestId: "request",
      status: "cancellation-requested", cancellationConfirmed: false, receiptId: "pg-cancel-one" });
    expect(await inspectPostgresRead(pgAccess(db), "request")).toMatchObject({ state: "observation-required", used_attempts: 1,
      unresolved_claims: 1, cancellation_requested_at: expect.any(String), receiptIds: ["pg-pending-one", "pg-cancel-one"] });
    const r = await db.prepare("SELECT payload,created_by FROM evidence_receipts WHERE tenant_id='tenant-a' AND id='pg-cancel-one'").bind()
      .first<{ payload: string; created_by: string }>();
    expect(JSON.parse(r!.payload)).toMatchObject({ outcome: "pending", reason: "postgresql_cancellation_requested", intentId: "one" });
    expect(r!.created_by).toBe("google:" + who);
  });
  it.each(["other-owner", "other-reader", "reviewer"])("refuses unrelated %s despite tenant membership", async who => {
    const { db } = await prepare(); await expect(cancelPostgresRead(pgAccess(db, who), "request")).rejects.toThrow();
    expect(await postgresCancellationRequested(pgAccess(db), "request", "one")).toBe(false);
  });
  it("refuses cross-tenant and unclaimed requests", async () => {
    const { db } = await prepare(false);
    await expect(cancelPostgresRead(pgAccess(db), "request")).rejects.toThrow();
    await expect(cancelPostgresRead(pgAccess(db, "reader", "tenant-b"), "request")).rejects.toThrow();
  });
  it("deduplicates only for currently authorized actors and keeps the original evidence", async () => {
    const { db } = await prepare(); const first = await cancelPostgresRead(pgAccess(db), "request");
    const before = await db.prepare("SELECT * FROM postgresql_cancellation_requests").bind().first();
    expect(await cancelPostgresRead(pgAccess(db, "owner"), "request")).toEqual(first);
    expect(await db.prepare("SELECT * FROM postgresql_cancellation_requests").bind().first()).toEqual(before);
    await pgRun(db, "UPDATE control_memberships SET active=0 WHERE principal_id='google:reader'");
    await expect(cancelPostgresRead(pgAccess(db), "request")).rejects.toThrow();
    await pgRun(db, "UPDATE control_memberships SET role='reader' WHERE principal_id='google:owner'");
    await expect(cancelPostgresRead(pgAccess(db, "owner"), "request")).rejects.toThrow();
  });
  it.each(["succeeded", "failed"])("refuses a new cancellation after confirmed %s", async outcome => {
    const { db, row } = await prepare();
    if (outcome === "succeeded") await observePostgresRead(pgAccess(db), "request", "one", "succeeded");
    else await recordPostgresFailure(pgAccess(db), "request", "one", row.statement_digest, "57014");
    await expect(cancelPostgresRead(pgAccess(db), "request")).rejects.toThrow();
    expect(await postgresCancellationRequested(pgAccess(db), "request", "one")).toBe(false);
  });
  it("binds executor polling to the exact tenant requester request and intent", async () => {
    const { db } = await prepare(); await cancelPostgresRead(pgAccess(db), "request");
    for (const [who, tenant, request, intent] of [["reader", "tenant-b", "request", "one"], ["owner", "tenant-a", "request", "one"],
      ["reader", "tenant-a", "other", "one"], ["reader", "tenant-a", "request", "other"]])
      expect(await postgresCancellationRequested(pgAccess(db, who, tenant), request, intent)).toBe(false);
    await pgRun(db, "UPDATE control_memberships SET active=0 WHERE principal_id='google:reader'");
    expect(await postgresCancellationRequested(pgAccess(db), "request", "one")).toBe(true);
  });
  it("keeps stop future-only and accepts cleanup intent after pending observation or retirement", async () => {
    const { db } = await prepare(); await stopPostgresRead(pgAccess(db), "request");
    expect(await postgresCancellationRequested(pgAccess(db), "request", "one")).toBe(false);
    await observePostgresRead(pgAccess(db), "request", "one", "observation-required");
    await postgresControlCommand(pgAccess(db, "owner"), "retire", { releaseId: "release", reason: "synthetic" });
    await cancelPostgresRead(pgAccess(db), "request");
    expect(await inspectPostgresRead(pgAccess(db), "request")).toMatchObject({ unresolved_claims: 1, state: "observation-required" });
  });
  it("rolls back cancellation if its receipt cannot be stored", async () => {
    const { db } = await prepare();
    await pgRun(db, "CREATE TRIGGER fail_cancel BEFORE INSERT ON evidence_receipts WHEN NEW.id='pg-cancel-one' BEGIN SELECT RAISE(ABORT,'synthetic'); END");
    await expect(cancelPostgresRead(pgAccess(db), "request")).rejects.toThrow();
    expect(await postgresCancellationRequested(pgAccess(db), "request", "one")).toBe(false);
    expect(await inspectPostgresRead(pgAccess(db), "request")).toMatchObject({ unresolved_claims: 1, used_attempts: 1 });
  });
  it("guards direct writes against forged authority binding mutation deletion and replacement", async () => {
    const { db } = await prepare();
    for (const [intent, actor] of [["other", "google:reader"], ["one", "google:other-owner"]])
      await expect(pgRun(db, "INSERT INTO postgresql_cancellation_requests(tenant_id,request_id,intent_id,requested_by) VALUES('tenant-a','request',?,?)",
        [intent, actor])).rejects.toThrow();
    await cancelPostgresRead(pgAccess(db), "request");
    for (const sql of ["UPDATE postgresql_cancellation_requests SET requested_by='google:owner'", "DELETE FROM postgresql_cancellation_requests",
      "INSERT OR REPLACE INTO postgresql_cancellation_requests(tenant_id,request_id,intent_id,requested_by) VALUES('tenant-a','request','one','google:reader')"])
      await expect(pgRun(db, sql)).rejects.toThrow();
  });
  it("rejects client backend identities and outcome assertions", async () => {
    const { db } = await prepare();
    for (const extra of [{ pid: 123 }, { outcome: "cancelled" }, { principalId: "google:owner" }])
      await expect(postgresControlCommand(pgAccess(db), "cancel", { requestId: "request", ...extra })).rejects.toThrow();
  });
  it("allows the named human owner to cancel a delegated claim with signed Agent inspection", async () => {
    const { db } = await prepare(false); const a = await approvePostgresAgentFixture(db);
    const v = await verifyPostgresAgent(db, pgAgentOrigin, "tenant-a", a.delegationId, a.signature, "execute");
    const { row } = await preparePostgresDispatch(v.access, v.requestId, v.proof);
    await claimPostgresRead(v.access, row, "agent-one", v.proof);
    await cancelPostgresRead(pgAccess(db, "owner"), v.requestId);
    expect(await postgresCancellationRequested(v.access, v.requestId, "agent-one")).toBe(true);
    const inspected = await verifyPostgresAgent(db, pgAgentOrigin, "tenant-a", a.delegationId, a.inspectSignature, "inspect");
    expect(await inspectPostgresAgent(inspected.access, inspected.proof)).toMatchObject({ cancellationRequestedAt: expect.any(String),
      state: "observation-required", unresolvedClaims: 1, receiptIds: ["pg-pending-agent-one", "pg-cancel-agent-one"] });
  });
}
