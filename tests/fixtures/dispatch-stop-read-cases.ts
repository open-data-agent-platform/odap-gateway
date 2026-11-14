import { describe, expect, it, vi } from "vitest";
import worker from "../../worker";
import { onRequestGet } from "../../functions/api/control/[tenant]/dispatch-stops/[id]";
import { onRequestPost } from "../../functions/api/control/[tenant]/dispatch-stops";
import { prepareIntentJob } from "../../lib/bigquery-job-storage";
import { stopBeforeDispatch } from "../../lib/pre-dispatch-stop";
import type { D1Database, D1PreparedStatement } from "../../lib/d1";
import { dispatchStopRequest } from "./dispatch-stop-command-cases";
import { recoveryCookie, recoveryEnv } from "./delegated-recovery-request-cases";

export function dispatchStopReadCases(database: () => D1Database) {
  const run = (sql: string) => database().prepare(sql).bind().run();
  const first = (sql: string) => database().prepare(sql).bind().first();
  const access = () => ({ db: database(), tenantId: "t", principalId: "google:operator" });
  const prepare = () => prepareIntentJob(access(), "i", { BIGQUERY_PROJECT_ID: "fixture-project", BIGQUERY_LOCATION: "US" });
  const claim = () => run("INSERT INTO dispatch_claims(tenant_id,intent_id,claimed_by,maximum_bytes_billed) VALUES('t','i','google:operator',128)");
  const snapshot = () => first(`SELECT reserved_units,spent_units,
    (SELECT count(*) FROM dispatch_stopped_intents) AS stops,(SELECT count(*) FROM dispatch_claims) AS claims,
    (SELECT count(*) FROM cost_settlements) AS settlements,(SELECT count(*) FROM evidence_receipts) AS receipts,
    (SELECT count(*) FROM bigquery_job_bindings) AS jobs,(SELECT count(*) FROM control_object_events) AS events
    FROM control_budgets WHERE tenant_id='t' AND id='b'`);
  const readOnly = (db = database()): D1Database => ({ prepare(sql) {
    expect(sql.startsWith("SELECT ")).toBe(true); const s = db.prepare(sql);
    const wrap = (st: D1PreparedStatement): D1PreparedStatement => ({ ...st, bind: (...args) => wrap(st.bind(...args)),
      first: <T>() => st.first<T>(), all: () => { throw new Error("No bulk read"); }, run: () => { throw new Error("No writes"); } });
    return wrap(s);
  } });
  const env = (db: D1Database) => ({ ...recoveryEnv(db), ODAP_DELEGATION_AUDIENCE: undefined, GATEWAY_BASE_PATH: "/gateway" });
  const request = async (subject = "operator", tenant = "t", id = "i") => new Request(
    "https://gateway.test/gateway/api/control/"+tenant+"/dispatch-stops/"+id, { headers: { Cookie: await recoveryCookie(subject) } });
  const call = async (subject = "operator", tenant = "t", id = "i", db = database()) =>
    worker.fetch(await request(subject,tenant,id), env(readOnly(db)), { waitUntil() {} });
  function beforeRead(effect: () => Promise<unknown>): D1Database {
    const db = database(); return { prepare(sql) {
      const s = db.prepare(sql); if (!sql.startsWith("SELECT c.intent_id")) return s;
      const wrap = (st: D1PreparedStatement): D1PreparedStatement => ({ ...st, bind: (...args) => wrap(st.bind(...args)),
        first: async<T>() => { await effect(); return st.first<T>(); } }); return wrap(s);
    } };
  }
  describe("owner-scoped stored dispatch stop inspection", { timeout: 30000 }, () => {
    it.each([false,true])("reads prepared=%s absence without granting execution or changing storage", async prepared => {
      if (prepared) await prepare(); const before = await snapshot();
      const outbound = vi.spyOn(globalThis,"fetch").mockRejectedValue(new Error("No provider contact"));
      try {
        const r = await call(); expect(r.status).toBe(200);
        const body = await r.json(); expect(body).toEqual({ ok: true, dispatchStop: { tenantId: "t", intentId: "i", state: "not-stopped",
          source: "stored-evidence", scope: "local-dispatch-stop", providerContacted: false, cancellationConfirmed: false,
          executionAuthorized: false, settlementAuthorized: false } });
        const direct = await onRequestGet({ request: await request(), env: env(readOnly()), params: { tenant: "t", id: "i" } });
        expect(await direct.json()).toEqual(body); expect(await snapshot()).toEqual(before); expect(outbound).not.toHaveBeenCalled();
        expect(r.headers.get("Cache-Control")).toBe("no-store");
      } finally { outbound.mockRestore(); }
    });
    it("recovers a committed stop after a lost POST readback without another command", async () => {
      const broken = beforeRead(async () => { throw new Error("synthetic-private-readback"); });
      const post = await onRequestPost({ request: dispatchStopRequest(await recoveryCookie()), env: env(broken), params: { tenant: "t" } });
      expect(post.status).toBe(503); const before = await snapshot(); expect(before).toMatchObject({ stops: 1 });
      const stored = await first("SELECT stopped_by,stopped_at FROM dispatch_stopped_intents") as { stopped_by: string; stopped_at: string };
      const response = await call(); expect(response.status).toBe(200); const body = await response.json();
      expect(body).toMatchObject({ ok: true, dispatchStop: { state: "stopped", stoppedBy: stored.stopped_by, stoppedAt: stored.stopped_at,
        providerContacted: false, cancellationConfirmed: false, executionAuthorized: false, settlementAuthorized: false } });
      for (let i=0;i<3;i++) expect(await (await call()).json()).toEqual(body);
      expect(await snapshot()).toEqual(before);
    });
    it.each(["reader","reviewer","inactive","absent","outsider"])("denies %s without writing or disclosing", async subject => {
      await stopBeforeDispatch(access(),"i"); await run("INSERT INTO control_tenants VALUES('peer','Peer')");
      await run("INSERT INTO control_memberships VALUES('t','google:reviewer','reviewer',1),('t','google:inactive','owner',0),('peer','google:outsider','owner',1)");
      const before = await snapshot(), r = await call(subject); expect(r.status).toBe(403);
      expect(await r.json()).toEqual({ ok: false, code: "tenant_access_denied" }); expect(await snapshot()).toEqual(before);
    });
    it("does not reveal foreign or absent intent state even to an owner of both tenants", async () => {
      await stopBeforeDispatch(access(),"i"); await run("INSERT INTO control_tenants VALUES('peer','Peer')");
      await run("INSERT INTO control_memberships VALUES('peer','google:operator','owner',1)");
      for (const [tenant,id] of [["peer","i"],["t","absent"]]) {
        const r = await call("operator",tenant,id); expect(r.status).toBe(403);
        expect(await r.json()).toEqual({ ok: false,code: "tenant_access_denied" });
      }
    });
    it("rechecks owner revocation in the evidence statement", async () => {
      await stopBeforeDispatch(access(),"i"); const db = beforeRead(() => run("UPDATE control_memberships SET active=0 WHERE principal_id='google:operator'"));
      const before = await snapshot(), r = await call("operator","t","i",db); expect(r.status).toBe(403);
      expect(await r.json()).toEqual({ ok: false,code: "tenant_access_denied" }); expect(await snapshot()).toEqual(before);
    });
    it("preserves historical attribution for a replacement current owner", async () => {
      await stopBeforeDispatch(access(),"i"); const body = await (await call()).json();
      await run("UPDATE control_memberships SET active=0 WHERE principal_id='google:operator'");
      expect((await call()).status).toBe(403); expect(await (await call("owner")).json()).toEqual(body);
    });
    it("reads an existing claim without a stop or provider outcome", async () => {
      await prepare(); await claim(); const before = await snapshot(), r = await call(); expect(r.status).toBe(200);
      expect(await r.json()).toMatchObject({ dispatchStop: { state: "already-claimed", providerContacted: false, cancellationConfirmed: false } });
      expect(await snapshot()).toEqual(before);
    });
    it("reads a settlement without creating a stop or releasing budget", async () => {
      await database().prepare("INSERT INTO evidence_receipts(tenant_id,id,contract_id,release_id,payload,created_by) VALUES('t','final','c','r',?,'owner')")
        .bind(JSON.stringify({ id: "final",tenantId: "t",contractId: "c",semanticReleaseId: "r",intentId: "i",outcome: "cancelled" })).run();
      await run("INSERT INTO cost_settlements(tenant_id,intent_id,receipt_id,actual_units,actor) VALUES('t','i','final',0,'owner')");
      const before = await snapshot(), r = await call(); expect(r.status).toBe(200);
      expect(await r.json()).toMatchObject({ dispatchStop: { state: "already-settled", settlementAuthorized: false, cancellationConfirmed: false } });
      expect(await snapshot()).toEqual(before);
    });
    it("reflects a stop committed immediately before its evidence SELECT", async () => {
      const db = beforeRead(() => stopBeforeDispatch(access(),"i")); const r = await call("operator","t","i",db);
      expect(r.status).toBe(200); expect(await r.json()).toMatchObject({ dispatchStop: { state: "stopped" } });
      expect(await snapshot()).toMatchObject({ stops: 1, claims: 0, settlements: 0, receipts: 0, reserved_units: 20, spent_units: 0 });
    });
    it("sanitizes storage failures without a fallback write or transport", async () => {
      const db = beforeRead(async () => { throw new Error("synthetic-private-storage"); });
      const before = await snapshot(), r = await call("operator","t","i",db); expect(r.status).toBe(503);
      expect(await r.json()).toEqual({ ok: false,code: "control_storage_unavailable" }); expect(await snapshot()).toEqual(before);
    });
  });
}
