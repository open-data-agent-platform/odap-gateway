import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../worker";
import { signAuthPayload, SESSION_COOKIE } from "../lib/auth";
import { inspectOwnIssuance } from "../lib/issuance-history";
import { inspectOwnAdmission } from "../lib/admission-history";
import { readOwnAdmission } from "../lib/delegated-admission";
import { confirmBudgetReservation } from "../lib/requester-budget-admission";
import { readOwnIssuance } from "../lib/delegated-issuance";
import { delegationFixture } from "./fixtures/delegation";
import { jobDatabase, jobSqlite } from "./fixtures/job-sqlite";

let dir: string, file: string, baseline: string, enrolled: CryptoKeyPair, delegationId: string;
const f = delegationFixture(() => file, () => enrolled);
const readonly = jobDatabase(() => file, "readonly"), expired = jobDatabase(() => file, "readonly-after-expiry");
const path = (tenant: string, id: string) => "/api/control/" + tenant + "/delegation-issuance/" + id;
const signal = new AbortController().signal;
const scope = () => ({ tenantId: "t", delegationId, grantId: "grant", requestId: "req" });
async function read(url: string, subject = "reader", audience = f.env.ODAP_DELEGATION_AUDIENCE, db = readonly, method = "GET") {
  const cookie = subject ? SESSION_COOKIE + "=" + await signAuthPayload({ provider: "google", providerId: subject,
    email: "fixture@example.test", name: "Fixture", expiresAt: Date.now()+60000 }, f.env.AUTH_COOKIE_SECRET) : "";
  return worker.fetch(new Request(f.origin + url, { method, headers: { Cookie: cookie, "X-Principal-Id": "google:reader" } }),
    { ...f.env, ODAP_DELEGATION_AUDIENCE: audience, DB: db }, { waitUntil: () => undefined });
}

async function provePeerCollision() {
  await f.sql("INSERT INTO control_tenants VALUES('peer','Peer')");
  await f.setupGrant("peer");
  await f.sql("INSERT INTO agent_verification_keys SELECT 'peer',agent_id,key_id,public_hex,active FROM agent_verification_keys WHERE tenant_id='t'");
  await f.sql("INSERT INTO agent_delegations SELECT 'peer',id,grant_id,audience,agent_id,key_id,NULL FROM agent_delegations WHERE tenant_id='t'");
  const d = await f.challenge("peer");
  expect(d.delegationId).toBe(delegationId);
  expect((await f.post("peer/delegation-proofs", { delegationId, signature: await f.sign(d.challenge) })).status).toBe(201);
}

describe("requester-only historical issuance and admission", { timeout: 30000 }, () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "odap-issuance-history-"));
    file = baseline = join(dir, "baseline.db");
    enrolled = await f.keys();
    await jobSqlite(file, "setup-v19");
    await f.setupGrant("t");
    await f.migrateAndEnroll();
    const d = await f.challenge();
    delegationId = d.delegationId;
    expect((await f.post("t/delegation-proofs", { delegationId, signature: await f.sign(d.challenge) })).status).toBe(201);
  }, 30000);
  beforeEach(async () => { file = join(dir, crypto.randomUUID()+".db"); await copyFile(baseline, file); });
  afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

  it("recovers a committed ID without the issuer reply, even at database expiry and after revocation", async () => {
    const url = path("t", delegationId);
    expect((await read(url)).status).toBe(503);
    await jobSqlite(file, "apply-contract-issuance");
    expect((await read(url)).status).toBe(404);
    // Discard the acknowledgement; the client has only the inspected delegation.
    expect((await f.post("t/contract-issuances", { delegationId }, "reader")).status).toBe(201);
    const { contractId } = await f.first("SELECT contract_id AS contractId FROM delegated_contract_issuances");
    const expected = { state: "ready", snapshot: { ...scope(), contractId } };
    const get = (db: typeof readonly): typeof fetch => async (u, init) => {
      expect(u).toBe(url);
      expect(init).toMatchObject({ method: "GET", credentials: "same-origin", redirect: "error", cache: "no-store" });
      const res = await read(url, "reader", f.env.ODAP_DELEGATION_AUDIENCE, db);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.clone().json()).toEqual({ ok: true, object: expected.snapshot });
      return res;
    };
    expect(await expired.prepare("SELECT count(*) AS n FROM issuable_delegations").bind().first()).toEqual({ n: 0 });
    expect(await inspectOwnIssuance(scope(), signal, get(expired))).toEqual(expected);
    expect((await f.revoke(delegationId)).status).toBe(200);
    expect(await f.first("SELECT count(*) AS n FROM issuable_delegations")).toEqual({ n: 0 });
    expect(await inspectOwnIssuance(scope(), signal, get(readonly))).toEqual(expected);
  });

  it("isolates colliding delegation IDs, requires audience and active original membership, and rejects writes", async () => {
    await jobSqlite(file, "apply-contract-issuance");
    const issue = async (tenant: string) => {
      const res = await f.post(tenant+"/contract-issuances", { delegationId }, "reader");
      expect(res.status).toBe(201);
      return (await res.json()).issuance.contractId;
    };
    const t = await issue("t");
    await provePeerCollision();
    const peer = await issue("peer");
    expect(t).not.toBe(peer);
    const url = path("t", delegationId);
    expect((await (await read(url)).json()).object.contractId).toBe(t);
    expect((await (await read(path("peer", delegationId))).json()).object.contractId).toBe(peer);
    for (const res of [await read(url, "owner"), await read(url, "reader", "different"), await read(path("t", "missing"))]) {
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ ok: false, code: "not_found" });
    }
    expect((await read(url, "")).status).toBe(401);
    expect((await read(url, "reader", "")).status).toBe(503);
    expect((await read(url, "reader", f.env.ODAP_DELEGATION_AUDIENCE, readonly, "POST")).status).toBe(405);
    await f.sql("UPDATE control_memberships SET active=0 WHERE tenant_id='t' AND principal_id='google:reader'");
    expect(await readOwnIssuance({ db: readonly, tenantId: "t", principalId: "google:reader" }, f.env.ODAP_DELEGATION_AUDIENCE, delegationId)).toBeNull();
    expect((await read(url)).status).toBe(403);
  });

  it("recovers a lost admission with GET only and separates tenants with the same contract and delegation IDs", async () => {
    await jobSqlite(file, "apply-contract-issuance");
    const issue = await f.post("t/contract-issuances", { delegationId }, "reader");
    expect(issue.status).toBe(201);
    const { issuance: { contractId } } = await issue.json();
    const url = "/api/control/t/contract-admission/" + contractId;
    expect((await read(url)).status).toBe(503);
    await jobSqlite(file, "apply-delegated-budget");
    expect((await read(url)).status).toBe(404);
    await provePeerCollision();
    await f.sql(`INSERT INTO delegated_contract_issuances SELECT 'peer',delegation_id,audience,requested_by,contract_id,reservation_id
      FROM delegated_contract_issuances WHERE tenant_id='t'`);
    await f.sql("INSERT INTO control_budgets(tenant_id,id,limit_units) VALUES('peer','b',100)");
    for (const [tenant, units] of [["t", "80"], ["peer", "31"]]) {
      await f.sql("INSERT INTO bigquery_scan_policies VALUES(?,'orders','p1','demo-project','US','on_demand',5000000,100000000,'2099-01-01T00:00:00.000Z','fixture')", [tenant]);
      await f.sql("INSERT INTO delegated_budget_policies VALUES(?,'orders','p1','b',?)", [tenant, units]);
    }
    const { expiresAt, actionDigest } = await f.first("SELECT expires_at AS expiresAt,action_digest AS actionDigest FROM issuable_delegations WHERE tenant_id='t'");
    const s = { tenantId: "t", contractId, delegationId, actionDigest };
    const quoted = { ...s, expiresAt, budgetId: "b", microUsd: 80 };
    const submit: typeof fetch = async (u, init) => {
      expect(u).toBe("/api/control/t/budget-admissions");
      expect((await f.post("t/budget-admissions", JSON.parse(String(init?.body)), "reader")).status).toBe(201);
      throw new Error("fixture: lost reply after commit");
    };
    expect(await confirmBudgetReservation(quoted, quoted, signal, submit)).toEqual({ state: "unknown" });
    const { intentId } = await f.first("SELECT intent_id AS intentId FROM delegated_admissions WHERE tenant_id='t'");
    const peer = await f.post("peer/budget-admissions", { contractId }, "reader");
    expect(peer.status).toBe(201);
    const peerIntent = (await peer.json()).admission.intentId;
    expect(peerIntent).not.toBe(intentId);
    const expected = { ...s, budgetId: "b", originalMicroUsd: 80, intentId };
    const ledger = () => f.first(`SELECT reserved_units,(SELECT count(*) FROM delegated_admissions) AS admissions,
      (SELECT count(*) FROM execution_intents) AS intents,(SELECT count(*) FROM bigquery_job_bindings) AS jobs,
      (SELECT count(*) FROM dispatch_claims) AS claims FROM control_budgets WHERE tenant_id='t' AND id='b'`);
    const before = await ledger();
    expect(before.reserved_units).toBe(100);
    for (const db of [readonly, expired]) {
      if (db === expired) expect((await f.revoke(delegationId)).status).toBe(200);
      const get: typeof fetch = async (u, init) => {
        expect(u).toBe(url);
        expect(init).toMatchObject({ method: "GET", cache: "no-store", credentials: "same-origin", redirect: "error" });
        const res = await read(url, "reader", f.env.ODAP_DELEGATION_AUDIENCE, db);
        expect(res.headers.get("cache-control")).toBe("no-store");
        expect(await res.clone().json()).toEqual({ ok: true, object: expected });
        return res;
      };
      expect(await inspectOwnAdmission(s, signal, get)).toEqual({ state: "ready", snapshot: expected });
    }
    expect(await ledger()).toEqual(before);
    expect((await (await read("/api/control/peer/contract-admission/"+contractId)).json()).object)
      .toEqual({ ...expected, tenantId: "peer", intentId: peerIntent, originalMicroUsd: 31 });
    for (const res of [await read(url,"owner"), await read(url,"reader","other"), await read("/api/control/t/contract-admission/missing")]) {
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ ok: false, code: "not_found" });
    }
    expect((await read(url,"")).status).toBe(401);
    expect((await read(url,"reader","")).status).toBe(503);
    expect((await read(url,"reader",f.env.ODAP_DELEGATION_AUDIENCE,readonly,"POST")).status).toBe(405);
    const receiptUrl = "/api/control/t/intent-receipt/" + intentId;
    expect((await read(receiptUrl)).status).toBe(503);
    for (const migration of ["apply-delegated-jobs","apply-delegated-handoff","apply-delegated-observations","apply-delegated-billing"])
      await jobSqlite(file, migration);
    const lookup = await read(receiptUrl);
    expect(lookup.status).toBe(200);
    expect(lookup.headers.get("cache-control")).toBe("no-store");
    expect(await lookup.json()).toEqual({ ok:true,object:{ ...s,intentId,receipt:null } });
    for (const res of [await read(receiptUrl,"owner"),await read(receiptUrl,"reader","foreign"),
      await read("/api/control/peer/intent-receipt/"+intentId)]) {
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ ok:false,code:"not_found" });
    }
    expect((await read(receiptUrl,"")).status).toBe(401);
    expect((await read(receiptUrl,"reader",f.env.ODAP_DELEGATION_AUDIENCE,readonly,"POST")).status).toBe(405);
    expect(await ledger()).toEqual(before);
    await f.sql("UPDATE control_memberships SET active=0 WHERE tenant_id='t' AND principal_id='google:reader'");
    expect((await read(receiptUrl)).status).toBe(403);
    expect(await readOwnAdmission({ db: readonly, tenantId: "t", principalId: "google:reader" }, f.env.ODAP_DELEGATION_AUDIENCE, contractId)).toBeNull();
    expect((await read(url)).status).toBe(403);
  });
});

it("does not display a substituted issuance or expose unrelated fields", async () => {
  const s = { tenantId: "demo", delegationId: "d", grantId: "g", requestId: "r" }, ref = { ...s, contractId: "c" };
  for (const changed of [{ tenantId: "other" }, { delegationId: "other" }, { requestId: "other" },
    { grantId: "other" }, { contractId: "../x" }, { contractId: null }]) {
    expect(await inspectOwnIssuance(s, signal, async () => Response.json({ ok: true, object: { ...ref, ...changed } }))).toEqual({ state: "unavailable" });
  }
  const get = vi.fn(async () => Response.json({ ok: true, object: { ...ref, reservationId: "hidden" } }));
  expect(await inspectOwnIssuance(s, signal, get)).toEqual({ state: "ready", snapshot: ref });
  expect(get).toHaveBeenCalledTimes(1);
});
