import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import worker from "../worker";
import { SESSION_COOKIE, signAuthPayload } from "../lib/auth";
import { readOwnProposal, requestMetricContract } from "../lib/contract-requests";
import { consentToDelegation } from "../lib/requester-delegation";
import { confirmBudgetReservation, inspectBudgetQuote } from "../lib/requester-budget-admission";
import { recordHumanGrant } from "../lib/contract-human-grants";
import { consumeContract, revokeContract } from "../lib/contract-lifecycle";
import { admitExecutionIntent } from "../lib/execution-intents";
import { prepareIntentJob } from "../lib/bigquery-job-storage";
import { delegationFixture } from "./fixtures/delegation";
import { jobDatabase, jobSqlite } from "./fixtures/job-sqlite";

let dir: string, file: string, baseline: string, enrolled: CryptoKeyPair;
const { db, env, sql, first, hex, keys, sign, origin, post, input, revoke, challenge, setupGrant, migrateAndEnroll } =
  delegationFixture(() => file, () => enrolled);

describe("requester-bound agent proof", { timeout: 25000 }, () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "odap-agent-proof-"));
    file = baseline = join(dir, "v19.db");
    enrolled = await keys();
    await jobSqlite(file, "setup-v19");
    await setupGrant("t");
  }, 25000);
  beforeEach(async () => {
    file = join(dir, crypto.randomUUID()+".db");
    await copyFile(baseline, file);
    await migrateAndEnroll();
  });
  afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });
  describe("consent from a recovered owner grant", () => {
    async function recover() {
      const r = await readOwnProposal({ db, tenantId: "t", principalId: "google:reader" }, "req", true);
      if (!r?.grantReference) throw new Error("Expected requester-scoped grant");
      return { tenantId: r.tenantId, requestId: r.id, grantId: r.grantReference.grantId, agentId: r.requestedAgentId,
        releaseId: r.releaseId, actionDigest: r.actionDigest, expiresAt: r.grantReference.expiresAt };
    }
    const transport = (bindings = env, subject = "reader"): typeof fetch => async (url, init) => {
      expect(url).toBe("/api/control/t/delegations");
      return post("t/delegations", JSON.parse(String(init?.body)), subject, bindings);
    };
    const counts = () => first(`SELECT (SELECT count(*) FROM agent_delegations) AS delegations,
      (SELECT count(*) FROM agent_delegation_proofs) AS proofs,(SELECT count(*) FROM approval_contracts) AS contracts,
      (SELECT count(*) FROM execution_intents) AS intents,(SELECT count(*) FROM dispatch_claims) AS dispatches,
      (SELECT sum(reserved_units) FROM control_budgets) AS reserved`);
    const signal = new AbortController().signal;
    it("recovers the same unused challenge after a lost acknowledgement without proving or issuing", async () => {
      const scope = await recover(), send = transport(), before = await counts();
      let original;
      expect(await consentToDelegation(scope, "k1", signal, async (...args) => {
        const res = await send(...args);
        original = (await res.json()).delegation;
        throw new Error("fixture: lost reply after durable consent");
      })).toEqual({ state: "unknown" });
      expect(original).toBeDefined();
      expect(await consentToDelegation(scope, "k1", signal, send)).toEqual({ state: "recorded",
        delegationId: original!.delegationId, challenge: original!.challenge });
      const alternative = await keys();
      await sql("INSERT INTO agent_verification_keys VALUES('t','reporter','k2',?,1)",
        [hex(await crypto.subtle.exportKey("raw", alternative.publicKey))]);
      expect(await consentToDelegation(scope, "k2", signal, send)).toEqual({ state: "refused" });
      expect(await counts()).toEqual({ ...before, delegations: before.delegations + 1 });
    });
    it("checks requester, key, live policy and database expiry even with a recently recovered reference", async () => {
      const scope = await recover(), before = await counts();
      expect(await consentToDelegation(scope, "k1", signal, transport(env, "owner"))).toEqual({ state: "refused" });
      expect(await consentToDelegation(scope, "missing", signal, transport())).toEqual({ state: "refused" });
      const expiredDb: typeof db = { prepare(q) {
        const p = db.prepare(q);
        return { ...p, bind(...args) {
          const s = p.bind(...args);
          return { ...s, run: () => jobSqlite(file, "run-after-expiry", q, args),
            first: <T>() => jobSqlite(file, "first-after-expiry", q, args) as Promise<T | null> };
        } };
      } };
      expect(await consentToDelegation(scope, "k1", signal, transport({ ...env, DB: expiredDb }))).toEqual({ state: "refused" });
      await sql("DELETE FROM dispatch_read_grants WHERE tenant_id='t'");
      expect(await consentToDelegation(scope, "k1", signal, transport())).toEqual({ state: "refused" });
      expect(await counts()).toEqual(before);
    });
  });
  it("requires authenticated requester consent and one signature from the enrolled agent", async () => {
    expect((await post("t/delegations", input)).status).toBe(401);
    expect((await post("t/delegations", input, "owner")).status).toBe(409);
    expect((await post("t/delegations", { ...input, publicKey: "mine" }, "reader")).status).toBe(400);
    expect((await post("t/delegations", { ...input, agentId: "another" }, "reader")).status).toBe(409);
    expect((await post("t/delegations", input, "reader", { ...env, ODAP_DELEGATION_AUDIENCE: "" })).status).toBe(503);
    expect((await post("t/delegations", input, "reader", env, { Origin: "https://elsewhere.test" })).status).toBe(403);
    const d = await challenge();
    expect(await challenge()).toEqual(d);
    expect(JSON.parse(d.challenge)).toMatchObject({ purpose: "odap.gateway.contract-delegation-proof.v1", audience: "test-gateway",
      tenantId: "t", delegationId: d.delegationId, grantId: "grant", requesterId: "google:reader", requestId: "req", agentId: "reporter",
      keyId: "k1", releaseId: "released", policyRevision: "p1", projectId: "demo-project", location: "US",
      expiresAt: d.expiresAt, actionDigest: expect.stringMatching(/^sha256:/) });
    const proof = { delegationId: d.delegationId, signature: await sign(d.challenge) };
    const counts = () => first(`SELECT (SELECT count(*) FROM approval_contracts) AS contracts,(SELECT count(*) FROM execution_intents) AS intents,
      (SELECT count(*) FROM dispatch_claims) AS dispatches,(SELECT sum(reserved_units) FROM control_budgets) AS reserved`);
    const before = await counts();
    const responses = await Promise.all([post("t/delegation-proofs", proof), post("t/delegation-proofs", proof)]);
    expect(responses.map(r => r.status).sort()).toEqual([201,403]);
    expect(await first("SELECT count(*) AS n FROM agent_delegation_proofs")).toEqual({ n: 1 });
    expect((await post("t/delegations", input, "reader")).status).toBe(409);
    expect((await revoke(d.delegationId, "owner")).status).toBe(409);
    const withdrawn = await revoke(d.delegationId);
    expect(withdrawn.status).toBe(200);
    const again = await revoke(d.delegationId);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(await withdrawn.json());
    expect((await revoke(d.delegationId,"owner")).status).toBe(409);
    expect(await first("SELECT count(*) AS n FROM current_agent_delegations")).toEqual({ n: 0 });
    expect(await counts()).toEqual(before);
  });
  it("rejects a substituted key, action, tenant, audience or nonce even when public IDs match", async () => {
    const d = await challenge(), valid = await sign(d.challenge), signatureFromOtherKey = await sign(d.challenge, await keys());
    await sql("INSERT INTO control_tenants VALUES('peer','Peer')");
    await setupGrant("peer");
    await sql("INSERT INTO agent_verification_keys SELECT 'peer',agent_id,key_id,public_hex,active FROM agent_verification_keys WHERE tenant_id='t'");
    const peer = await challenge("peer");
    expect((await post("peer/delegation-proofs", { delegationId: peer.delegationId, signature: valid })).status).toBe(403);
    expect((await post("peer/delegations", { operation: "revoke", delegationId: d.delegationId }, "reader")).status).toBe(409);
    expect((await post("t/delegation-proofs", { delegationId: d.delegationId, signature: valid }, undefined,
      { ...env, ODAP_DELEGATION_AUDIENCE: "other" })).status).toBe(403);
    for (const signature of [signatureFromOtherKey, await sign(d.challenge.replace("sha256:", "edited:")), "00", "z".repeat(128)]) {
      expect((await post("t/delegation-proofs", { delegationId: d.delegationId, signature }, "reader")).status).toBe(403);
    }
    const scope = JSON.parse(d.challenge);
    for (const field of ["purpose","tenantId","audience","agentId","delegationId","location","projectId","requesterId"]) {
      const signature = await sign(JSON.stringify({ ...scope, [field]: "substitution" }));
      expect((await post("t/delegation-proofs", { delegationId: d.delegationId, signature })).status).toBe(403);
    }
    expect(await first("SELECT count(*) AS n FROM agent_delegation_proofs")).toEqual({ n: 0 });
  });
  it("orders proof and withdrawal on separate connections; neither ordering leaves a usable delegation", async () => {
    const d = await challenge(), proof = { delegationId: d.delegationId, signature: await sign(d.challenge) };
    const [signed, revoked] = await Promise.all([post("t/delegation-proofs", proof), revoke(d.delegationId)]);
    expect(revoked.status).toBe(200);
    expect([201,403]).toContain(signed.status);
    expect(await first("SELECT count(*) AS n FROM agent_delegation_proofs")).toEqual({ n: Number(signed.status === 201) });
    expect(await first("SELECT count(*) AS n FROM current_agent_delegations")).toEqual({ n: 0 });
    expect((await post("t/delegation-proofs", proof)).status).toBe(403);
  });
  it.each(["revoke","disable key","policy drift","expire","deactivate requester"])("rejects %s after signature verification but before proof storage", async change => {
    const d = await challenge();
    let claims = 0;
    const hooked: typeof db = { prepare(q) {
      const prepared = db.prepare(q);
      if (!q.startsWith("INSERT INTO agent_delegation_proofs")) return prepared;
      return { ...prepared, bind(...args) {
        const stmt = prepared.bind(...args);
        return { ...stmt, async first<T>() {
          claims++;
          if (change === "expire") return jobSqlite(file, "first-after-expiry", q, args);
          if (change === "revoke") expect((await revoke(d.delegationId)).status).toBe(200);
          if (change === "disable key") await sql("UPDATE agent_verification_keys SET active=0");
          if (change === "policy drift") await sql("DELETE FROM dispatch_read_grants WHERE tenant_id='t'");
          if (change === "deactivate requester") await sql("UPDATE control_memberships SET active=0 WHERE principal_id='google:reader'");
          return stmt.first<T>();
        } };
      } };
    } };
    const res = await post("t/delegation-proofs", { delegationId: d.delegationId, signature: await sign(d.challenge) }, undefined, { ...env, DB: hooked });
    expect(claims).toBe(1);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, code: "delegation_proof_denied" });
    expect(await first("SELECT count(*) AS n FROM agent_delegation_proofs")).toEqual({ n: 0 });
  });
  it("does not bless an existing grant on upgrade or let a disabled key be replaced or reactivated", async () => {
    file = join(dir,"upgrade.db");
    await copyFile(baseline,file);
    expect((await post("t/delegations",input,"reader")).status).toBe(503);
    await jobSqlite(file,"apply-agent-delegations");
    expect((await post("t/delegations",input,"reader")).status).toBe(409);
    expect(await first("SELECT count(*) AS n FROM agent_delegations")).toEqual({ n: 0 });
    await sql("INSERT INTO agent_verification_keys VALUES('t','reporter','k1',?,0)",[hex(await crypto.subtle.exportKey("raw",enrolled.publicKey))]);
    await expect(sql("UPDATE agent_verification_keys SET active=1")).rejects.toThrow();
    await expect(sql("INSERT OR REPLACE INTO agent_verification_keys SELECT tenant_id,agent_id,key_id,public_hex,1 FROM agent_verification_keys")).rejects.toThrow();
    expect((await post("t/delegations",input,"reader")).status).toBe(409);
  });

  describe("bounded contract issuance", () => {
    const migrate = () => jobSqlite(file, "apply-contract-issuance");
    const issue = (delegationId: string, subject = "reader", bindings = env) =>
      post("t/contract-issuances", { delegationId }, subject, bindings);
    const ledger = () => first(`SELECT (SELECT count(*) FROM delegated_contract_issuances) AS issuances,
      (SELECT count(*) FROM approval_contracts) AS contracts,(SELECT count(*) FROM contract_lifecycle_events) AS events,
      (SELECT count(*) FROM control_object_events WHERE object_kind='contract') AS audits`);
    const costs = () => first(`SELECT (SELECT count(*) FROM execution_intents) AS intents,
      (SELECT count(*) FROM dispatch_claims) AS dispatches,(SELECT sum(reserved_units) FROM control_budgets) AS reserved`);
    async function proven(grantId = input.grantId) {
      const d = await challenge("t", grantId);
      expect((await post("t/delegation-proofs", { delegationId: d.delegationId, signature: await sign(d.challenge) })).status).toBe(201);
      return d;
    }
    it("issues once on a populated v20 upgrade and holds the stored contract against legacy consumption", async () => {
      const d = await proven();
      expect((await issue(d.delegationId)).status).toBe(503);
      await migrate();
      const before = await ledger(), funds = await costs();
      expect(before.issuances).toBe(0);
      const [a,b] = await Promise.all([issue(d.delegationId),issue(d.delegationId)]);
      expect([a.status,b.status].sort()).toEqual([200,201]);
      expect(await a.json()).toEqual(await b.json());
      const replay = await issue(d.delegationId);
      expect(replay.status).toBe(200);
      const { issuance } = await replay.json() as { issuance: { delegationId: string; contractId: string } };
      const path = "/api/control/t/contract/" + issuance.contractId;
      expect(issuance.delegationId).toBe(d.delegationId);
      expect([a,b,replay].map(r => r.headers.get("Location"))).toEqual([path,path,path]);
      const session = await signAuthPayload({ provider: "google", providerId: "reader", name: "Fixture", email: "reader@example.test",
        expiresAt: Date.now()+60000 }, env.AUTH_COOKIE_SECRET);
      const read = await worker.fetch(new Request(origin+path, { headers: { Cookie: SESSION_COOKIE+"="+session } }), env, { waitUntil: () => undefined });
      expect(read.status).toBe(200);
      const { object } = await read.json() as { object: { reservationId: string; actionDigest: string } };
      expect(object).toEqual({ schemaVersion: "0.1", id: issuance.contractId, tenantId: "t", semanticReleaseId: "released",
        principalId: "google:reader", agentId: "reporter", actionDigest: JSON.parse(d.challenge).actionDigest,
        policyRevision: "p1", sourceRevision: "s1", target: "orders", actionType: "data.read",
        authority: { mode: "human", reference: "grant" }, reservationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        expiresAt: d.expiresAt, state: "authorized" });
      await expect(sql("INSERT OR REPLACE INTO contract_lifecycle SELECT tenant_id,contract_id,'consumed',changed_by,reason FROM contract_lifecycle WHERE contract_id=?", [issuance.contractId])).rejects.toThrow();
      await expect(sql("INSERT OR REPLACE INTO approval_contracts SELECT * FROM approval_contracts WHERE id=?", [issuance.contractId])).rejects.toThrow();
      const actor = { db, tenantId: "t", principalId: "google:reader" };
      await expect(consumeContract(actor,issuance.contractId)).rejects.toThrow();
      await expect(admitExecutionIntent(actor,{ id: "bypass", contractId: issuance.contractId, budgetId: "b",
        reservationId: object.reservationId, actionDigest: object.actionDigest, reservedUnits: 0 })).rejects.toThrow();
      expect(await ledger()).toEqual({ issuances: 1, contracts: before.contracts+1, events: before.events+1, audits: before.audits+1 });
      expect(await costs()).toEqual(funds);
      expect(await revokeContract({ ...actor, principalId: "google:owner" }, issuance.contractId,"fixture stop")).toBe(true);
      expect((await issue(d.delegationId)).status).toBe(409);
    });
    it("recovers the original identifiers after storage commits but the issuer loses its confirmation", async () => {
      await migrate();
      const d = await proven(), before = await ledger();
      let committedId: string | undefined;
      const hooked: typeof db = { prepare(q) {
        const prepared = db.prepare(q);
        if (!q.startsWith("INSERT INTO delegated_contract_issuances")) return prepared;
        return { ...prepared, bind(...args) {
          const stmt = prepared.bind(...args);
          return { ...stmt, async first() {
            committedId = (await stmt.first<{ contractId: string }>())?.contractId;
            throw new Error("fixture: lost D1 response after commit");
          } };
        } };
      } };
      const lost = await issue(d.delegationId, "reader", { ...env, DB: hooked });
      expect(lost.status).toBe(503);
      expect(committedId).toBeTruthy();
      const replay = await issue(d.delegationId);
      expect(replay.status).toBe(200);
      expect(await replay.json()).toEqual({ ok: true, issuance: { delegationId: d.delegationId, contractId: committedId } });
      expect(await ledger()).toEqual({ issuances: 1, contracts: before.contracts+1, events: before.events+1, audits: before.audits+1 });
    });
    it("orders revocation against issuance on independent connections", async () => {
      await migrate();
      const d = await proven(), before = await ledger(), funds = await costs();
      const [issued, revoked] = await Promise.all([issue(d.delegationId),revoke(d.delegationId)]);
      expect(revoked.status).toBe(200);
      expect([201,409]).toContain(issued.status);
      expect((await issue(d.delegationId)).status).toBe(409);
      const n = Number(issued.status === 201);
      expect(await ledger()).toEqual({ issuances: n, contracts: before.contracts+n, events: before.events+n, audits: before.audits+n });
      expect(await costs()).toEqual(funds);
    });
    it("does not accept unproven or foreign authority, forged terms or a client-selected expiry/reservation", async () => {
      await migrate();
      const d = await challenge(), before = await ledger();
      expect((await issue(d.delegationId)).status).toBe(409);
      expect((await post("t/delegation-proofs", { delegationId: d.delegationId, signature: await sign(d.challenge) })).status).toBe(201);
      expect((await post("t/contract-issuances", { delegationId: d.delegationId })).status).toBe(401);
      expect((await issue(d.delegationId,"owner")).status).toBe(409);
      expect((await issue(d.delegationId,"reader",{ ...env, ODAP_DELEGATION_AUDIENCE: "wrong" })).status).toBe(409);
      await sql("INSERT INTO control_tenants VALUES('peer','Peer')");
      await sql("INSERT INTO control_memberships VALUES('peer','google:reader','reader',1)");
      expect((await post("peer/contract-issuances", { delegationId: d.delegationId }, "reader")).status).toBe(409);
      for (const extra of [{ contractId: "custom" }, { expiresAt: "2099" }, { reservationId: "free" }, { actionDigest: "mine" }])
        expect((await post("t/contract-issuances", { delegationId: d.delegationId, ...extra }, "reader")).status).toBe(400);
      expect((await post("t/contract-issuances", { delegationId: d.delegationId }, "reader", env, { Origin: "https://other.test" })).status).toBe(403);
      expect(await ledger()).toEqual(before);
    });
    it.each(["revoke","expire","disable key","move target"])("refuses %s at the issuance write after proof", async change => {
      await migrate();
      const d = await proven(), before = await ledger();
      let writes = 0;
      const hooked: typeof db = { prepare(q) {
        const prepared = db.prepare(q);
        if (!q.startsWith("INSERT INTO delegated_contract_issuances")) return prepared;
        return { ...prepared, bind(...args) {
          const stmt = prepared.bind(...args);
          return { ...stmt, async first<T>() {
            writes++;
            if (change === "expire") return jobSqlite(file, "first-after-expiry", q, args);
            if (change === "revoke") expect((await revoke(d.delegationId)).status).toBe(200);
            if (change === "disable key") await sql("UPDATE agent_verification_keys SET active=0");
            if (change === "move target") await sql("UPDATE dispatch_targets SET location='EU'");
            return stmt.first<T>();
          } };
        } };
      } };
      const denied = await issue(d.delegationId, "reader", { ...env, DB: hooked });
      expect(writes).toBe(1);
      expect(denied.status).toBe(409);
      expect(await denied.json()).toEqual({ ok: false, code: "contract_issuance_unavailable" });
      expect(await ledger()).toEqual(before);
    });
    it("rolls issuance, contract and lifecycle back together on audit failure", async () => {
      await migrate();
      const d = await proven(), before = await ledger();
      await sql(`CREATE TRIGGER fail_issuance_audit BEFORE INSERT ON control_object_events
        WHEN NEW.object_kind='contract' BEGIN SELECT RAISE(ABORT,'internal fixture detail'); END`);
      const failed = await issue(d.delegationId);
      expect(failed.status).toBe(503);
      expect(await failed.json()).toEqual({ ok: false, code: "control_storage_unavailable" });
      expect(await ledger()).toEqual(before);
      await sql("DROP TRIGGER fail_issuance_audit");
      expect((await issue(d.delegationId)).status).toBe(201);
      expect((await revoke(d.delegationId)).status).toBe(200);
      expect((await issue(d.delegationId)).status).toBe(409);
      expect((await ledger()).issuances).toBe(1);
    });

    describe("delegated budget admission", () => {
      const upgrade = () => jobSqlite(file, "apply-delegated-budget");
      const admit = (id: string) => post("t/budget-admissions", { contractId: id }, "reader");
      const owner = { db, tenantId: "t", principalId: "google:owner" };
      async function issued(grantId = input.grantId) {
        const d = await proven(grantId);
        const res = await issue(d.delegationId);
        expect(res.status).toBe(201);
        const { issuance } = await res.json() as { issuance: { contractId: string; delegationId: string } };
        return issuance;
      }
      const price = (location = "US", validUntil = "2099-01-01T00:00:00.000Z", rate = "5000000") =>
        sql("INSERT INTO bigquery_scan_policies VALUES('t','orders','p1','demo-project',?,'on_demand',?,100000000,?,'fixture')",
          [location,rate,validUntil]);
      const policy = (units = "80") => sql("INSERT INTO delegated_budget_policies VALUES('t','orders','p1','b',?)", [units]);
      const snapshot = () => first(`SELECT (SELECT count(*) FROM delegated_admissions) AS admitted,
        (SELECT count(*) FROM contract_lifecycle l JOIN delegated_contract_issuances i USING(tenant_id,contract_id)
         WHERE l.state='consumed') AS consumed, (SELECT count(*) FROM execution_intents) AS intents,
        (SELECT reserved_units FROM control_budgets WHERE tenant_id='t' AND id='b') AS reserved,
        (SELECT count(*) FROM bigquery_job_bindings) AS jobs,(SELECT count(*) FROM dispatch_claims) AS claims`);

      it.each(["confirm", "revoke before confirm"])("reviews the bound allowance read-only: %s", async change => {
        await migrate();
        const { delegationId, contractId } = await issued();
        const { expiresAt, actionDigest } = await first("SELECT expires_at AS expiresAt,action_digest AS actionDigest FROM issuable_delegations");
        const scope = { tenantId: "t", delegationId, contractId, actionDigest, expiresAt }, signal = new AbortController().signal;
        const readonly = jobDatabase(() => file, "readonly");
        const get = (subject = "reader", audience = env.ODAP_DELEGATION_AUDIENCE): typeof fetch => async (url, init) => {
          expect(init?.method).toBe("GET");
          const cookie = SESSION_COOKIE + "=" + await signAuthPayload({ provider: "google", providerId: subject, name: "Fixture",
            email: "fixture@example.test", expiresAt: Date.now()+60000 }, env.AUTH_COOKIE_SECRET);
          const res = await worker.fetch(new Request(origin+url, { headers: { Cookie: cookie } }), { ...env, DB: readonly, ODAP_DELEGATION_AUDIENCE: audience }, { waitUntil: () => undefined });
          expect(res.headers.get("cache-control")).toBe("no-store");
          return res;
        };
        expect(await inspectBudgetQuote(scope, signal, get())).toEqual({ state: "unavailable" });
        await upgrade(); await price(); await policy();
        const before = await snapshot();
        for (const transport of [get("owner"), get("reader", "wrong-audience")])
          expect(await inspectBudgetQuote(scope, signal, transport)).toEqual({ state: "not_found" });
        const quote = await inspectBudgetQuote(scope, signal, get());
        expect(quote).toEqual({ state: "ready", snapshot: { ...scope, microUsd: 80, budgetId: "b" } });
        expect(await snapshot()).toEqual(before);
        if (quote.state !== "ready") throw new Error("Expected eligible quote");
        const submit: typeof fetch = (url, init) => {
          expect(url).toBe("/api/control/t/budget-admissions");
          expect(init?.method).toBe("POST");
          expect(JSON.parse(String(init?.body))).toEqual({ contractId });
          return admit(contractId);
        };
        if (change === "revoke before confirm") {
          expect((await revoke(delegationId)).status).toBe(200);
          expect(await confirmBudgetReservation(scope, quote.snapshot, signal, submit)).toEqual({ state: "refused" });
          expect(await snapshot()).toEqual(before);
        } else {
          const ack = await confirmBudgetReservation(scope, quote.snapshot, signal, submit);
          expect(ack).toMatchObject({ state: "acknowledged", replay: false });
          expect(await confirmBudgetReservation(scope, quote.snapshot, signal, submit)).toEqual({ ...ack, replay: true });
          expect(await snapshot()).toEqual({ ...before, admitted: 1, consumed: 1, intents: before.intents+1, reserved: before.reserved+80 });
        }
        expect(await inspectBudgetQuote(scope, signal, get())).toEqual({ state: "not_found" });
      });

      it("upgrades without funding old contracts, reserves once on retry and cannot prepare a job", async () => {
        await migrate();
        const i = await issued();
        await upgrade();
        const before = await snapshot();
        expect(before).toMatchObject({ admitted: 0, consumed: 0, reserved: 20 });
        expect((await admit(i.contractId)).status).toBe(409);
        await price();
        expect((await admit(i.contractId)).status).toBe(409);
        await policy();
        await expect(sql("INSERT OR REPLACE INTO delegated_budget_policies VALUES('t','orders','p1','b',1)")).rejects.toThrow();
        const [a,b] = await Promise.all([admit(i.contractId), admit(i.contractId)]);
        expect([a.status,b.status].sort()).toEqual([200,201]);
        const body = await a.json() as { admission: { intentId: string; contractId: string } };
        expect(await b.json()).toEqual(body);
        expect(body.admission.contractId).toBe(i.contractId);
        const stored = await db.prepare(`SELECT e.contract_id,e.budget_id,e.reserved_units,e.principal_id,
          e.reservation_id=i.reservation_id AS same_reservation FROM execution_intents e
          JOIN delegated_contract_issuances i USING(tenant_id,contract_id) WHERE e.id=?`)
          .bind(body.admission.intentId).first();
        expect(stored).toEqual({ contract_id: i.contractId, budget_id: "b", reserved_units: 80, principal_id: "google:reader", same_reservation: 1 });
        await expect(prepareIntentJob(owner,body.admission.intentId,{ BIGQUERY_PROJECT_ID: "demo-project", BIGQUERY_LOCATION: "US" }))
          .rejects.toThrow(/delegated dispatch disabled/);
        expect((await revoke(i.delegationId)).status).toBe(200);
        expect((await admit(i.contractId)).status).toBe(409);
        expect(await snapshot()).toEqual({ ...before, admitted: 1, consumed: 1, intents: before.intents+1, reserved: 100 });
      });
      it("will not accept client-selected terms, a foreign requester, or legacy zero-cost consumption", async () => {
        await migrate();
        const i = await issued();
        await upgrade(); await price(); await policy();
        const before = await snapshot();
        expect((await post("t/budget-admissions", { contractId: i.contractId })).status).toBe(401);
        expect((await post("t/budget-admissions", { contractId: i.contractId }, "owner")).status).toBe(409);
        expect((await post("t/budget-admissions", { contractId: i.contractId }, "reader", { ...env, ODAP_DELEGATION_AUDIENCE: "other" })).status).toBe(409);
        await sql("INSERT INTO control_tenants VALUES('peer','Peer')");
        await sql("INSERT INTO control_memberships VALUES('peer','google:reader','reader',1)");
        expect((await post("peer/budget-admissions", { contractId: i.contractId }, "reader")).status).toBe(409);
        for (const extra of [{ reservedUnits: 0 }, { budgetId: "b" }, { intentId: "chosen" }])
          expect((await post("t/budget-admissions", { contractId: i.contractId, ...extra }, "reader")).status).toBe(400);
        const actor = { ...owner, principalId: "google:reader" };
        await expect(consumeContract(actor,i.contractId)).rejects.toThrow();
        const binding = await db.prepare(`SELECT i.reservation_id AS reservationId,d.action_digest AS actionDigest
          FROM delegated_contract_issuances i JOIN issuable_delegations d USING(tenant_id,delegation_id) WHERE i.contract_id=?`)
          .bind(i.contractId).first<{ reservationId: string; actionDigest: string }>();
        await expect(admitExecutionIntent(actor,{ ...binding!, id: "bypass", contractId: i.contractId, budgetId: "b", reservedUnits: 0 })).rejects.toThrow();
        expect(await snapshot()).toEqual(before);
      });
      it.each(["price expired","wrong location","zero affordable bytes","overrun","revoked","policy changed"])("rejects %s at admission", async change => {
        await migrate();
        const i = await issued();
        await upgrade();
        await price(change === "wrong location" ? "EU" : "US",
          change === "price expired" ? "2000-01-01T00:00:00.000Z" : undefined,
          change === "zero affordable bytes" ? "9007199254740991" : undefined);
        await policy();
        if (change === "overrun") await sql("UPDATE control_budgets SET overrun_units=1");
        if (change === "revoked") expect((await revoke(i.delegationId)).status).toBe(200);
        if (change === "policy changed") await sql("UPDATE dispatch_targets SET policy_revision='p2'");
        const before = await snapshot();
        expect((await admit(i.contractId)).status).toBe(409);
        expect(await snapshot()).toEqual(before);
      });
      it("cannot overspend the last allowance when two distinct issued contracts race", async () => {
        await migrate();
        const a = await issued();
        const action = { profile: "odap.metric-read.v1", target: "orders", metricId: "revenue", parameters: { year: 2026 } };
        const req = { requestId: "another", releaseId: "released", requestedAgentId: "reporter" };
        expect(await requestMetricContract({ ...owner, principalId: "google:reader" }, { ...req, action })).toBeTruthy();
        expect(await recordHumanGrant(owner, { ...req, grantId: "another-grant", requesterId: "google:reader",
          reviewedAction: action, policyRevision: "p1" })).toBeTruthy();
        const b = await issued("another-grant");
        await upgrade(); await price(); await policy();
        const before = await snapshot();
        const results = await Promise.all([admit(a.contractId),admit(b.contractId)]);
        expect(results.map(r=>r.status).sort()).toEqual([201,409]);
        expect(await snapshot()).toEqual({ ...before, admitted: 1, consumed: 1, intents: before.intents+1, reserved: 100 });
      });
      it("rolls back a nested lifecycle-event failure and permits a clean retry", async () => {
        await migrate();
        const i = await issued();
        await upgrade(); await price(); await policy();
        const before = await snapshot();
        await sql("CREATE TRIGGER fail_admit BEFORE INSERT ON contract_lifecycle_events BEGIN SELECT RAISE(ABORT,'fixture fault'); END");
        const failed = await admit(i.contractId);
        expect(failed.status).toBe(503);
        expect(await failed.json()).toEqual({ ok: false, code: "control_storage_unavailable" });
        expect(await snapshot()).toEqual(before);
        await sql("DROP TRIGGER fail_admit");
        expect((await admit(i.contractId)).status).toBe(201);
      });
      it("recovers a lost commit confirmation with the same intent even at zero remaining capacity", async () => {
        await migrate();
        const i = await issued();
        await upgrade(); await price(); await policy();
        const before = await snapshot();
        let committed: string | undefined;
        const hooked: typeof db = { prepare(q) {
          const prepared = db.prepare(q);
          if (!q.startsWith("INSERT INTO delegated_admissions")) return prepared;
          return { ...prepared, bind(...args) {
            const stmt = prepared.bind(...args);
            return { ...stmt, async first() {
              committed = (await stmt.first<{ intentId: string }>())?.intentId;
              throw new Error("fixture: missing commit acknowledgement");
            } };
          } };
        } };
        const lost = await post("t/budget-admissions", { contractId: i.contractId }, "reader", { ...env, DB: hooked });
        expect(lost.status).toBe(503);
        expect(committed).toBeTruthy();
        const replay = await admit(i.contractId);
        expect(replay.status).toBe(200);
        expect(await replay.json()).toEqual({ ok: true, admission: { contractId: i.contractId, intentId: committed } });
        expect(await snapshot()).toEqual({ ...before, admitted: 1, consumed: 1, intents: before.intents+1, reserved: 100 });
      });
    });
  });
});
