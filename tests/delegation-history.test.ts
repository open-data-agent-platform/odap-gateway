import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../worker";
import { readOwnDelegation } from "../lib/agent-delegations";
import { SESSION_COOKIE, signAuthPayload } from "../lib/auth";
import { inspectOwnDelegation } from "../lib/delegation-history";
import { revokeInspectedDelegation } from "../lib/requester-delegation-revocation";
import { issueForReviewedDelegation } from "../lib/requester-contract-issuance";
import { delegationFixture } from "./fixtures/delegation";
import { jobDatabase, jobSqlite } from "./fixtures/job-sqlite";

let dir: string, file: string, baseline: string, enrolled: CryptoKeyPair;
const fixture = delegationFixture(() => file, () => enrolled);
const { env, origin, sql, setupGrant, migrateAndEnroll, challenge, post, sign, revoke } = fixture;
const readonly = jobDatabase(() => file, "readonly");
async function lookup(subject = "reader", tenant = "t", grantId = "grant", audience = env.ODAP_DELEGATION_AUDIENCE, method = "GET") {
  const session = subject ? SESSION_COOKIE + "=" + await signAuthPayload({ provider: "google", providerId: subject,
    email: "fixture@example.test", name: "Fixture", expiresAt: Date.now() + 60000 }, env.AUTH_COOKIE_SECRET) : "";
  return worker.fetch(new Request(origin + "/api/control/" + tenant + "/grant-delegation/" + grantId, {
    method, headers: { Cookie: session, "X-Principal-Id": "google:reader" } }), { ...env, DB: readonly, ODAP_DELEGATION_AUDIENCE: audience },
    { waitUntil: () => undefined });
}

describe("requester-scoped delegation history", { timeout: 30000 }, () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "odap-delegation-history-"));
    file = baseline = join(dir, "baseline.db");
    enrolled = await fixture.keys();
    await jobSqlite(file, "setup-v19");
    await setupGrant("t");
  });
  beforeEach(async () => { file = join(dir, crypto.randomUUID() + ".db"); await copyFile(baseline, file); });
  afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

  it("reads the same record before proof, after proof, and after revocation without returning signing material", async () => {
    await migrateAndEnroll();
    expect((await lookup()).status).toBe(404);
    const d = await challenge();
    const expected = { tenantId: "t", grantId: "grant", requestId: "req", agentId: "reporter", keyId: "k1",
      delegationId: d.delegationId, expiresAt: d.expiresAt, verifiedAt: null, revokedAt: null };
    const initial = await lookup();
    expect(initial.status).toBe(200);
    expect(initial.headers.get("cache-control")).toBe("no-store");
    expect(await initial.json()).toEqual({ ok: true, object: expected });
    const proof = await post("t/delegation-proofs", { delegationId: d.delegationId, signature: await sign(d.challenge) });
    expect(proof.status).toBe(201);
    const verifiedAt = (await fixture.first("SELECT verified_at AS at FROM agent_delegation_proofs")).at;
    expect((await (await lookup()).json()).object).toEqual({ ...expected, verifiedAt });
    const revocation = await revoke(d.delegationId);
    expect(revocation.status).toBe(200);
    const { revokedAt } = (await revocation.json()).revocation;
    await sql("UPDATE agent_verification_keys SET active=0");
    await sql("DELETE FROM dispatch_read_grants");
    const result = await inspectOwnDelegation(expected, new AbortController().signal, () => lookup());
    expect(result).toEqual({ state: "ready", snapshot: { ...expected, verifiedAt, revokedAt } });
  });

  it("recovers a lost revocation reply through history; explicit replay preserves the original timestamp and proof", async () => {
    await migrateAndEnroll();
    const d = await challenge(), signal = new AbortController().signal;
    expect((await post("t/delegation-proofs", { delegationId: d.delegationId, signature: await sign(d.challenge) })).status).toBe(201);
    const before = await readOwnDelegation({ db: readonly, tenantId: "t", principalId: "google:reader" }, "test-gateway", "grant");
    if (!before?.verifiedAt || before.revokedAt !== null) throw new Error("Expected a proven, unrevoked delegation");
    const ledger = () => fixture.first(`SELECT (SELECT count(*) FROM agent_delegations) AS delegations,
      (SELECT count(*) FROM agent_delegation_proofs) AS proofs,(SELECT count(*) FROM approval_contracts) AS contracts,
      (SELECT count(*) FROM execution_intents) AS intents,(SELECT count(*) FROM dispatch_claims) AS dispatches,
      (SELECT sum(reserved_units) FROM control_budgets) AS reserved`);
    const original = await ledger(), times: string[] = [], methods: string[] = [];
    const transport: typeof fetch = async (url, init) => {
      methods.push(String(init?.method));
      if (init?.method === "GET") {
        expect(url).toBe("/api/control/t/grant-delegation/grant");
        return lookup();
      }
      expect(url).toBe("/api/control/t/delegations");
      const command = JSON.parse(String(init?.body));
      expect(command).toEqual({ operation: "revoke", delegationId: before.delegationId });
      const result = await post("t/delegations", command, "reader");
      expect(result.status).toBe(200);
      times.push((await result.clone().json()).revocation.revokedAt);
      if (times.length === 1) throw new Error("fixture: dropped acknowledgement");
      return result;
    };
    const first = await revokeInspectedDelegation(before, signal, transport);
    expect(first).toEqual({ state: "ready", snapshot: { ...before, revokedAt: times[0] } });
    expect(await revokeInspectedDelegation(before, signal, transport)).toEqual(first);
    expect(methods).toEqual(["POST", "GET", "POST", "GET"]);
    expect(times).toEqual([times[0], times[0]]);
    expect(await ledger()).toEqual(original);
    expect(await fixture.first("SELECT count(*) AS n FROM current_agent_delegations")).toEqual({ n: 0 });
  });

  it("recovers a lost issuance acknowledgement on explicit replay and refuses a stale proof after revocation", async () => {
    await migrateAndEnroll();
    const d = await challenge();
    expect((await post("t/delegation-proofs", { delegationId: d.delegationId, signature: await sign(d.challenge) })).status).toBe(201);
    await jobSqlite(file, "apply-contract-issuance");
    const snapshot = (await (await lookup()).json()).object;
    const { releaseId, actionDigest } = JSON.parse(d.challenge);
    const scope = { ...snapshot, releaseId, actionDigest }, signal = new AbortController().signal;
    const cookie = SESSION_COOKIE + "=" + await signAuthPayload({ provider: "google", providerId: "reader", name: "Fixture",
      email: "reader@example.test", expiresAt: Date.now()+60000 }, env.AUTH_COOKIE_SECRET);
    const costs = () => fixture.first(`SELECT (SELECT count(*) FROM execution_intents) AS intents,
      (SELECT count(*) FROM dispatch_claims) AS dispatches,(SELECT sum(reserved_units) FROM control_budgets) AS reserved`);
    const originalCosts = await costs(), writes: number[] = [], reads: string[] = [];
    const send: typeof fetch = async (url, init) => {
      if (init?.method === "POST") {
        expect(url).toBe("/api/control/t/contract-issuances");
        expect(JSON.parse(String(init.body))).toEqual({ delegationId: d.delegationId });
        const res = await post("t/contract-issuances", JSON.parse(String(init.body)), "reader");
        writes.push(res.status);
        if (writes.length === 1) throw new Error("fixture: lost reply after commit");
        return res;
      }
      reads.push(String(url));
      return worker.fetch(new Request(origin + url, { headers: { Cookie: cookie } }), { ...env, DB: readonly }, { waitUntil: () => undefined });
    };
    expect(await issueForReviewedDelegation(scope, snapshot, signal, send)).toEqual({ state: "unknown" });
    expect(writes).toEqual([201]);
    const { contractId } = await fixture.first("SELECT contract_id AS contractId FROM delegated_contract_issuances");
    expect(await issueForReviewedDelegation(scope, snapshot, signal, send)).toEqual({ state: "recorded", contractId, contractState: "authorized" });
    expect((await revoke(d.delegationId)).status).toBe(200);
    expect(await issueForReviewedDelegation(scope, snapshot, signal, send)).toEqual({ state: "refused" });
    expect(writes).toEqual([201, 200, 409]);
    expect(reads).toEqual(["/api/control/t/contract/" + contractId]);
    expect(await fixture.first("SELECT count(*) AS n FROM delegated_contract_issuances")).toEqual({ n: 1 });
    expect(await costs()).toEqual(originalCosts);
  });

  it("isolates colliding tenant grant, delegation and proof IDs and rechecks requester membership", async () => {
    await migrateAndEnroll();
    const d = await challenge();
    expect((await post("t/delegation-proofs", { delegationId: d.delegationId, signature: await sign(d.challenge) })).status).toBe(201);
    await sql("INSERT INTO control_tenants VALUES('peer','Peer')");
    await setupGrant("peer");
    await sql("INSERT INTO agent_verification_keys SELECT 'peer',agent_id,key_id,public_hex,active FROM agent_verification_keys WHERE tenant_id='t'");
    await sql("INSERT INTO agent_delegations SELECT 'peer',id,grant_id,audience,agent_id,key_id,NULL FROM agent_delegations WHERE tenant_id='t'");
    expect((await (await lookup("reader", "peer")).json()).object).toMatchObject({ tenantId: "peer", delegationId: d.delegationId, verifiedAt: null });
    for (const res of [await lookup("owner"), await lookup("reader", "t", "absent"), await lookup("reader", "t", "grant", "different")]) {
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ ok: false, code: "not_found" });
    }
    expect((await lookup("")).status).toBe(401);
    expect((await lookup("reader", "t", "grant", "")).status).toBe(503);
    expect((await lookup("reader", "t", "grant", "test-gateway", "POST")).status).toBe(405);
    await sql("UPDATE control_memberships SET active=0 WHERE tenant_id='t' AND principal_id='google:reader'");
    expect(await readOwnDelegation({ db: readonly, tenantId: "t", principalId: "google:reader" }, "test-gateway", "grant")).toBeNull();
    expect((await lookup()).status).toBe(403);
  });

  it("keeps expired records visible and distinguishes an unavailable history store from an absent delegation", async () => {
    expect((await lookup()).status).toBe(503);
    await migrateAndEnroll();
    await sql(`INSERT INTO contract_requests SELECT tenant_id,principal_id,'old-request',release_id,requested_agent_id,
      action_digest,'2020-01-01T00:00:00.000Z' FROM contract_requests WHERE id='req'`);
    await sql(`INSERT INTO contract_human_grants SELECT tenant_id,'old-grant',requester_id,'old-request',granted_by,policy_revision,
      project_id,location,'2020-01-01T00:01:00.000Z','2020-01-01T00:11:00.000Z' FROM contract_human_grants WHERE id='grant'`);
    await sql("INSERT INTO agent_delegations VALUES('t','old-delegation','old-grant','test-gateway','reporter','k1',NULL)");
    expect((await (await lookup("reader", "t", "old-grant")).json()).object).toMatchObject({ delegationId: "old-delegation",
      requestId: "old-request", expiresAt: "2020-01-01T00:11:00.000Z", verifiedAt: null, revokedAt: null });
  });
});

describe("delegation history client", () => {
  const scope = { tenantId: "demo", grantId: "g1", requestId: "req", agentId: "reporter", expiresAt: "2020-01-01T00:10:00.000Z" };
  const snapshot = { ...scope, delegationId: "d1", keyId: "k1", verifiedAt: null, revokedAt: null };
  it("uses only GET and exposes only the historical projection", async () => {
    const get = vi.fn(async () => Response.json({ ok: true, object: { ...snapshot, challenge: "do not return", active: true } }));
    const signal = new AbortController().signal;
    expect(await inspectOwnDelegation(scope, signal, get)).toEqual({ state: "ready", snapshot });
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith("/api/control/demo/grant-delegation/g1", { method: "GET", credentials: "same-origin", cache: "no-store", redirect: "error", signal });
  });
  it("rejects scope mismatches, invalid IDs and missing or malformed event times", async () => {
    for (const extra of [{ tenantId: "other" }, { grantId: "other" }, { requestId: "other" }, { agentId: "other" },
      { expiresAt: "2020-01-01T00:20:00.000Z" }, { delegationId: "../other" }, { keyId: "" }, { verifiedAt: undefined }, { revokedAt: "now" }]) {
      expect(await inspectOwnDelegation(scope, new AbortController().signal, async () => Response.json({ ok: true, object: { ...snapshot, ...extra } })))
        .toEqual({ state: "unavailable" });
    }
  });
  it("never uses a write acknowledgement or substituted history as revocation evidence", async () => {
    const verifiedAt = "2020-01-01T00:01:00.000Z", revokedAt = "2020-01-01T00:02:00.000Z";
    const before = { ...snapshot, verifiedAt };
    for (const change of [{ delegationId: "other" }, { keyId: "other" }, { verifiedAt: null }, { grantId: "other" },
      { requestId: "other" }, { revokedAt: null }]) {
      const send = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => init?.method === "POST"
        ? Response.json({ ok: true, revocation: { revokedAt } }) : Response.json({ ok: true, object: { ...before, revokedAt, ...change } }));
      expect(await revokeInspectedDelegation(before, new AbortController().signal, send)).toEqual({ state: "revocation_unknown" });
      expect(send.mock.calls.map(([, init]) => init?.method)).toEqual(["POST", "GET"]);
    }
    const send = vi.fn();
    expect(await revokeInspectedDelegation({ ...before, revokedAt }, new AbortController().signal, send)).toEqual({ state: "invalid" });
    expect(await revokeInspectedDelegation(before, AbortSignal.abort(), send)).toEqual({ state: "revocation_unknown" });
    expect(send).not.toHaveBeenCalled();
  });
  it("pins the inspected scope across the write while allowing a concurrent proof to appear", async () => {
    const before = { ...snapshot }, latest = { ...before, verifiedAt: "2020-01-01T00:01:00.000Z", revokedAt: "2020-01-01T00:02:00.000Z" };
    const send: typeof fetch = async (url, init) => {
      if (init?.method === "POST") {
        before.grantId = "different";
        return new Response(null, { status: 503 });
      }
      expect(url).toBe("/api/control/demo/grant-delegation/g1");
      return Response.json({ ok: true, object: latest });
    };
    expect(await revokeInspectedDelegation(before, new AbortController().signal, send)).toEqual({ state: "ready", snapshot: latest });
  });
});
