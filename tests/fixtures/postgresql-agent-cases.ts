import { expect, it, vi } from "vitest";
import type { D1Database } from "../../lib/d1";
import { canonicalControlJson, isApprovalContract } from "../../lib/control-objects";
import { approvePostgresAgentRead, approvePostgresRead, claimPostgresRead, inspectPostgresRead, observePostgresRead,
  preparePostgresDispatch, requestPostgresRead, stopPostgresRead } from "../../lib/postgresql-control";
import { delegatePostgresRead, inspectPostgresAgent, postgresAgentChallenges, revokePostgresDelegation,
  verifyPostgresAgent, type PostgresAgentProof } from "../../lib/postgresql-agent";
import { retireSemanticRelease } from "../../lib/semantic-candidate-storage";
import { pgAccess, pgAction, pgRun, publishPostgresFixture } from "./postgresql-control";
import { approvePostgresAgentFixture, enrollPostgresAgent, pgAgentOrigin } from "./postgresql-agent";

export function postgresAgentCases(getDb: () => D1Database) {
  async function start() { const db = getDb(); await publishPostgresFixture(db); return { db, a: await approvePostgresAgentFixture(db) }; }
  const verify = (db: D1Database, a: Awaited<ReturnType<typeof approvePostgresAgentFixture>>) =>
    verifyPostgresAgent(db, pgAgentOrigin, "tenant-a", a.delegationId, a.signature, "execute");
  it("requires the registered private key and persists the original principal plus agent in the contract", async () => {
    const { db, a } = await start();
    const contract = await db.prepare("SELECT payload FROM approval_contracts WHERE tenant_id='tenant-a' AND id=?").bind(a.contractId).first<{ payload: string }>();
    const value = JSON.parse(contract!.payload); expect(isApprovalContract(value)).toBe(true);
    expect(value).toMatchObject({ principalId: "google:reader", agentId: "agent-one", expiresAt: a.challenges.expiresAt });
    const approval = await db.prepare("SELECT expires_at FROM postgresql_read_approvals WHERE tenant_id='tenant-a' AND request_id='agent-request'").bind().first<{ expires_at: string }>();
    expect(approval!.expires_at > a.challenges.expiresAt).toBe(true);
    expect(await inspectPostgresRead(pgAccess(db), "agent-request")).toMatchObject({ expires_at: a.challenges.expiresAt });
    const v = await verify(db, a), { row } = await preparePostgresDispatch(v.access, "agent-request", v.proof);
    expect(await claimPostgresRead(v.access, row, "attempt", v.proof)).toBe(true);
    await observePostgresRead(v.access, "agent-request", "attempt", "succeeded");
    const inspected = await verifyPostgresAgent(db, pgAgentOrigin, "tenant-a", a.delegationId, a.inspectSignature, "inspect");
    expect(await inspectPostgresAgent(inspected.access, inspected.proof)).toMatchObject({ state: "succeeded", agentId: "agent-one" });
    expect(await db.prepare("PRAGMA foreign_key_check").bind().first()).toBeNull();
    await expect(verify(db, a)).rejects.toThrow();
  });
  it("refuses session execution, forged proof objects and an inspect signature used to execute", async () => {
    const { db, a } = await start();
    await expect(preparePostgresDispatch(pgAccess(db), "agent-request")).rejects.toThrow();
    await expect(preparePostgresDispatch(pgAccess(db), "agent-request", {} as PostgresAgentProof)).rejects.toThrow();
    await expect(verifyPostgresAgent(db, pgAgentOrigin, "tenant-a", a.delegationId, a.inspectSignature, "execute")).rejects.toThrow();
    const inspected = await verifyPostgresAgent(db, pgAgentOrigin, "tenant-a", a.delegationId, a.inspectSignature, "inspect");
    await expect(preparePostgresDispatch(inspected.access, "agent-request", inspected.proof)).rejects.toThrow();
    const v = await verify(db, a), { row } = await preparePostgresDispatch(v.access, "agent-request", v.proof);
    await expect(claimPostgresRead(pgAccess(db), row, "attempt")).rejects.toThrow();
  });
  it.each(["audience", "tenant", "delegation", "signature", "purpose", "action", "source", "contract"])("rejects substituted %s signing terms", async field => {
    const { db, a } = await start(); let signature = a.signature;
    if (["purpose", "action", "source", "contract"].includes(field)) {
      const scope = JSON.parse(a.challenges.execute);
      scope[{ purpose: "purpose", action: "actionDigest", source: "sourceId", contract: "contractId" }[field]!] = "substituted";
      signature = await a.sign(canonicalControlJson(scope));
    }
    await expect(verifyPostgresAgent(db, field === "audience" ? "https://other.test" : pgAgentOrigin,
      field === "tenant" ? "tenant-b" : "tenant-a", field === "delegation" ? "other" : a.delegationId,
      field === "signature" ? "0".repeat(128) : signature, "execute")).rejects.toThrow();
    expect(await inspectPostgresRead(pgAccess(db), "agent-request")).toMatchObject({ used_attempts: 0 });
  });
  it.each(["key", "revoke", "requester", "owner", "source", "stop", "retire", "contract"])("rechecks %s after signature verification at the final atomic claim", async change => {
    const { db, a } = await start(), v = await verify(db, a), { row } = await preparePostgresDispatch(v.access, "agent-request", v.proof);
    if (change === "key") await pgRun(db, "UPDATE agent_verification_keys SET active=0");
    else if (change === "revoke") await revokePostgresDelegation(pgAccess(db), pgAgentOrigin, a.delegationId);
    else if (change === "requester" || change === "owner") await pgRun(db, "UPDATE control_memberships SET active=0 WHERE tenant_id='tenant-a' AND principal_id=?", [change === "owner" ? "google:owner" : "google:reader"]);
    else if (change === "source") await pgRun(db, "UPDATE postgresql_source_heads SET active=0");
    else if (change === "stop") await stopPostgresRead(pgAccess(db), "agent-request");
    else if (change === "retire") await retireSemanticRelease(pgAccess(db, "owner"), "release", "synthetic");
    else await pgRun(db, "UPDATE contract_lifecycle SET state='revoked' WHERE tenant_id='tenant-a' AND contract_id=?", [a.contractId]);
    expect(await claimPostgresRead(v.access, row, "attempt", v.proof)).toBe(false);
    expect(await db.prepare("SELECT count(*) AS n FROM postgresql_read_claims").bind().first()).toEqual({ n: 0 });
  });
  it("admits one signature replay winner and never rearms an uncertain claim", async () => {
    const { db, a } = await start(), v = await verify(db, a), { row } = await preparePostgresDispatch(v.access, "agent-request", v.proof);
    const results = await Promise.allSettled(["one", "two", "three"].map(id => claimPostgresRead(v.access, row, id, v.proof)));
    expect(results.filter(r => r.status === "fulfilled" && r.value)).toHaveLength(1);
    expect(await inspectPostgresRead(pgAccess(db), "agent-request")).toMatchObject({ used_attempts: 1, state: "observation-required" });
    await expect(verify(db, a)).rejects.toThrow();
  });
  it("requires requester consent before owner approval and forbids attaching an agent after a session approval", async () => {
    const db = getDb(); await publishPostgresFixture(db); await enrollPostgresAgent(db);
    await requestPostgresRead(pgAccess(db), { requestId: "request", releaseId: "release", action: pgAction });
    for (const principal of ["owner", "other-reader"]) await expect(delegatePostgresRead(pgAccess(db, principal), pgAgentOrigin,
      { requestId: "request", agentId: "agent-one", keyId: "key-one" })).rejects.toThrow();
    const approval = { requestId: "request", releaseId: "release", sourceId: "revision-1", requesterId: "google:reader", reviewedAction: pgAction };
    await expect(approvePostgresAgentRead(pgAccess(db, "owner"), pgAgentOrigin,
      { ...approval, delegationId: "missing", agentId: "agent-one", keyId: "key-one" })).rejects.toThrow();
    await approvePostgresRead(pgAccess(db, "owner"), approval);
    await expect(delegatePostgresRead(pgAccess(db), pgAgentOrigin, { requestId: "request", agentId: "agent-one", keyId: "key-one" })).rejects.toThrow();
  });
  it("does not turn delegated consent into a session approval or substitute an owner-reviewed key", async () => {
    const db = getDb(); await publishPostgresFixture(db); await enrollPostgresAgent(db);
    await requestPostgresRead(pgAccess(db), { requestId: "request", releaseId: "release", action: pgAction });
    const a = await delegatePostgresRead(pgAccess(db), pgAgentOrigin, { requestId: "request", agentId: "agent-one", keyId: "key-one" });
    const input = { requestId: "request", releaseId: "release", sourceId: "revision-1", requesterId: "google:reader", reviewedAction: pgAction };
    await expect(approvePostgresRead(pgAccess(db, "owner"), input)).rejects.toThrow();
    await expect(approvePostgresAgentRead(pgAccess(db, "owner"), pgAgentOrigin,
      { ...input, delegationId: a.delegationId, agentId: "agent-one", keyId: "other-key" })).rejects.toThrow();
    await expect(approvePostgresAgentRead(pgAccess(db, "other-owner"), pgAgentOrigin,
      { ...input, delegationId: a.delegationId, agentId: "agent-one", keyId: "key-one" })).rejects.toThrow();
  });
  it("preserves consent history and requester recovery after idempotent revocation", async () => {
    const { db, a } = await start();
    await expect(revokePostgresDelegation(pgAccess(db, "other-reader"), pgAgentOrigin, a.delegationId)).rejects.toThrow();
    await expect(postgresAgentChallenges(pgAccess(db, "other-reader"), pgAgentOrigin, a.delegationId)).rejects.toThrow();
    const revoked = await revokePostgresDelegation(pgAccess(db), pgAgentOrigin, a.delegationId);
    expect(await revokePostgresDelegation(pgAccess(db), pgAgentOrigin, a.delegationId)).toEqual(revoked);
    await expect(verify(db, a)).rejects.toThrow();
    await expect(verifyPostgresAgent(db, pgAgentOrigin, "tenant-a", a.delegationId, a.inspectSignature, "inspect")).rejects.toThrow();
    expect(await inspectPostgresRead(pgAccess(db), "agent-request")).toMatchObject({ used_attempts: 0, delegation_revoked_at: revoked.revokedAt });
    for (const sql of ["DELETE FROM postgresql_agent_delegations", "UPDATE postgresql_agent_delegations SET agent_id='other'",
      "INSERT OR REPLACE INTO postgresql_agent_delegations SELECT * FROM postgresql_agent_delegations"])
      await expect(pgRun(db, sql)).rejects.toThrow();
  });
  it("rechecks key revocation during asynchronous signature verification", async () => {
    const { db, a } = await start(); const original = crypto.subtle.verify.bind(crypto.subtle);
    const spy = vi.spyOn(crypto.subtle, "verify").mockImplementation(async (...args) => {
      const result = await original(...args); await pgRun(db, "UPDATE agent_verification_keys SET active=0"); return result;
    });
    try {
      const v = await verify(db, a);
      await expect(preparePostgresDispatch(v.access, "agent-request", v.proof)).rejects.toThrow();
    } finally { spy.mockRestore(); }
  });
  it("allows read-only signed recovery after retirement but not new execution", async () => {
    const { db, a } = await start(), v = await verify(db, a), { row } = await preparePostgresDispatch(v.access, "agent-request", v.proof);
    await claimPostgresRead(v.access, row, "attempt", v.proof); await retireSemanticRelease(pgAccess(db, "owner"), "release", "synthetic");
    const inspected = await verifyPostgresAgent(db, pgAgentOrigin, "tenant-a", a.delegationId, a.inspectSignature, "inspect");
    expect(await inspectPostgresAgent(inspected.access, inspected.proof)).toMatchObject({ state: "observation-required" });
    await expect(verify(db, a)).rejects.toThrow();
  });
}
