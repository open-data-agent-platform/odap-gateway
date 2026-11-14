import { describe, expect, it, vi } from "vitest";
import worker from "../../worker";
import { onRequestPost } from "../../functions/api/control/[tenant]/dispatch-stops";
import { prepareIntentJob } from "../../lib/bigquery-job-storage";
import type { D1Database, D1PreparedStatement } from "../../lib/d1";
import { recoveryCookie, recoveryEnv } from "./delegated-recovery-request-cases";

export function dispatchStopRequest(cookie: string, intentId = "i", tenant = "t") {
  return new Request("https://gateway.test/gateway/api/control/"+tenant+"/dispatch-stops", { method: "POST",
    headers: { Cookie: cookie, Origin: "https://gateway.test", "Content-Type": "application/json" }, body: JSON.stringify({ intentId }) });
}
export function dispatchStopCommandCases(database: () => D1Database) {
  const run = (sql: string) => database().prepare(sql).bind().run();
  const first = (sql: string) => database().prepare(sql).bind().first();
  const env = (db = database()) => ({ ...recoveryEnv(db), ODAP_DELEGATION_AUDIENCE: undefined, GATEWAY_BASE_PATH: "/gateway" });
  const call = async (subject = "operator", tenant = "t", intentId = "i", db = database()) =>
    worker.fetch(dispatchStopRequest(await recoveryCookie(subject), intentId, tenant), env(db), { waitUntil() {} });
  const stops = () => first("SELECT count(*) AS n FROM dispatch_stopped_intents");
  const held = () => first(`SELECT reserved_units,spent_units,
    (SELECT count(*) FROM dispatch_claims) AS claims,(SELECT count(*) FROM cost_settlements) AS settlements,
    (SELECT count(*) FROM evidence_receipts) AS receipts,(SELECT count(*) FROM bigquery_job_bindings) AS jobs,
    (SELECT count(*) FROM bigquery_terminal_observations) AS observations,
    (SELECT count(*) FROM bigquery_cancellation_requests) AS requests FROM control_budgets WHERE tenant_id='t' AND id='b'`);
  const prepare = () => prepareIntentJob({ db: database(), tenantId: "t", principalId: "google:operator" }, "i",
    { BIGQUERY_PROJECT_ID: "fixture-project", BIGQUERY_LOCATION: "US" });
  const claim = () => run("INSERT INTO dispatch_claims(tenant_id,intent_id,claimed_by,maximum_bytes_billed) VALUES('t','i','google:operator',128)");
  function intercept(match: (sql: string) => boolean, effect: () => Promise<unknown>, phase: "first" | "run"): D1Database {
    const base = database(); return { prepare(sql) {
      const statement = base.prepare(sql); if (!match(sql)) return statement;
      const wrap = (s: D1PreparedStatement): D1PreparedStatement => ({ ...s, bind: (...args) => wrap(s.bind(...args)),
        first: async<T>() => { if (phase === "first") await effect(); return s.first<T>(); },
        run: async<T>() => { if (phase === "run") await effect(); return s.run<T>(); }
      }); return wrap(statement);
    } };
  }
  describe("authenticated pre-dispatch stop command", { timeout: 30000 }, () => {
    it.each([false, true])("stops prepared=%s without provider contact or accounting changes", async prepared => {
      if (prepared) await prepare(); const before = await held();
      const outbound = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No network"));
      try {
        const r = await call(); expect(r.status).toBe(200);
        const row = await first("SELECT stopped_by,stopped_at FROM dispatch_stopped_intents");
        const body = await r.json(); expect(body).toEqual({ ok: true, dispatchStop: { tenantId: "t", intentId: "i",
          stoppedBy: "google:operator", stoppedAt: (row as { stopped_at: string }).stopped_at,
          scope: "local-dispatch-stop", providerContacted: false, cancellationConfirmed: false,
          executionAuthorized: false, settlementAuthorized: false } });
        expect(r.headers.get("Cache-Control")).toBe("no-store"); expect(r.headers.get("X-Content-Type-Options")).toBe("nosniff");
        expect(await held()).toEqual(before); expect(await stops()).toEqual({ n: 1 }); expect(outbound).not.toHaveBeenCalled();
        const direct = await onRequestPost({ request: dispatchStopRequest(await recoveryCookie()), env: env(), params: { tenant: "t" } });
        expect(await direct.json()).toEqual(body);
        // Legacy preparation only records metadata; the stop must still block handoff.
        if (!prepared) await prepare();
        await expect(claim()).rejects.toThrow();
        expect(await first("SELECT count(*) AS n FROM dispatch_claims")).toEqual({ n: 0 });
      } finally { outbound.mockRestore(); }
    });
    it("concurrent owners and retries preserve the first stopper and time", async () => {
      const [a,b] = await Promise.all([call(),call("owner")]); expect(a.status).toBe(200); expect(b.status).toBe(200);
      const body = await a.json(); expect(await b.json()).toEqual(body); expect(await (await call()).json()).toEqual(body);
      expect(await stops()).toEqual({ n: 1 });
    });
    it.each(["reader", "reviewer", "inactive", "absent", "outsider"])("denies %s without recording a stop", async subject => {
      await run("INSERT INTO control_tenants VALUES('peer','Peer')");
      await run("INSERT INTO control_memberships VALUES('t','google:reviewer','reviewer',1),('t','google:inactive','owner',0),('peer','google:outsider','owner',1)");
      const before = await held(); expect((await call(subject)).status).toBe(403);
      expect(await stops()).toEqual({ n: 0 }); expect(await held()).toEqual(before);
    });
    it("does not disclose foreign or absent intent state to an owner of both tenants", async () => {
      await run("INSERT INTO control_tenants VALUES('peer','Peer')");
      await run("INSERT INTO control_memberships VALUES('peer','google:operator','owner',1)");
      for (const [tenant,intent] of [["peer","i"],["t","absent"]]) {
        const r = await call("operator",tenant,intent); expect(r.status).toBe(503);
        expect(await r.json()).toEqual({ ok: false, code: "control_storage_unavailable" });
      }
      expect(await stops()).toEqual({ n: 0 });
    });
    it.each(["write", "readback"])("rechecks owner revocation at %s without disclosing a stop", async phase => {
      const db = intercept(sql => sql.startsWith(phase === "write" ? "INSERT INTO dispatch_stopped_intents" : "SELECT c.intent_id"),
        () => run("UPDATE control_memberships SET active=0 WHERE principal_id='google:operator'"), phase === "write" ? "run" : "first");
      const before = await held(), r = await call("operator","t","i",db); expect(r.status).toBe(503);
      expect(await r.json()).toEqual({ ok: false, code: "control_storage_unavailable" });
      expect(await stops()).toEqual({ n: phase === "write" ? 0 : 1 }); expect(await held()).toEqual(before);
    });
    it("acknowledges the historical stopper only to a replacement current owner", async () => {
      const body = await (await call()).json();
      await run("UPDATE control_memberships SET active=0 WHERE principal_id='google:operator'");
      expect((await call()).status).toBe(403); expect(await (await call("owner")).json()).toEqual(body);
      expect(await stops()).toEqual({ n: 1 });
    });
    it("refuses an already claimed job without inferring a warehouse cancellation", async () => {
      await prepare(); await claim(); const before = await held(); const r = await call();
      expect(r.status).toBe(409); expect(await r.json()).toEqual({ ok: false, code: "dispatch_stop_unavailable" });
      expect(await stops()).toEqual({ n: 0 }); expect(await held()).toEqual(before);
    });
    it("a claim winning immediately before the stop write prevents success", async () => {
      await prepare(); const db = intercept(sql => sql.startsWith("INSERT INTO dispatch_stopped_intents"), claim, "run");
      const r = await call("operator","t","i",db); expect(r.status).toBe(409); expect(await stops()).toEqual({ n: 0 });
      expect(await held()).toMatchObject({ claims: 1, reserved_units: 20, spent_units: 0, requests: 0, settlements: 0 });
    });
    it("does not create a stop or change accounting for an already settled intent", async () => {
      await database().prepare("INSERT INTO evidence_receipts(tenant_id,id,contract_id,release_id,payload,created_by) VALUES('t','final','c','r',?,'owner')")
        .bind(JSON.stringify({ id: "final",tenantId: "t",contractId: "c",semanticReleaseId: "r",intentId: "i",outcome: "cancelled" })).run();
      await run("INSERT INTO cost_settlements(tenant_id,intent_id,receipt_id,actual_units,actor) VALUES('t','i','final',0,'owner')");
      const before = await held(), r = await call(); expect(r.status).toBe(409);
      expect(await r.json()).toEqual({ ok: false,code: "dispatch_stop_unavailable" });
      expect(await held()).toEqual(before); expect(await stops()).toEqual({ n: 0 });
    });
    it("the stop and claim race admits only one local winner", async () => {
      await prepare(); const [stop,claimed] = await Promise.allSettled([call(),claim()]);
      expect(stop.status).toBe("fulfilled"); if (stop.status !== "fulfilled") throw new Error("Missing stop response");
      if (stop.value.status === 200) { expect(claimed.status).toBe("rejected"); expect(await stops()).toEqual({ n: 1 }); }
      else { expect(stop.value.status).toBe(409); expect(claimed.status).toBe("fulfilled"); expect(await stops()).toEqual({ n: 0 }); }
      expect(await held()).toMatchObject({ reserved_units: 20, spent_units: 0, settlements: 0, requests: 0 });
    });
    it("readback failure can follow a committed stop; explicit retry recovers it once", async () => {
      const before = await held(), db = intercept(sql => sql.startsWith("SELECT c.intent_id"), async () => { throw new Error("synthetic-private-readback"); }, "first");
      const r = await call("operator","t","i",db); expect(r.status).toBe(503);
      expect(await r.json()).toEqual({ ok: false, code: "control_storage_unavailable" }); expect(await stops()).toEqual({ n: 1 });
      expect((await call()).status).toBe(200); expect(await stops()).toEqual({ n: 1 }); expect(await held()).toEqual(before);
    });
    it("refuses a false-success write result and sanitizes storage failures", async () => {
      const before = await held(), base = database();
      for (const mode of ["false", "throw"] as const) {
        const db: D1Database = { prepare(sql) {
          if (!sql.startsWith("INSERT INTO dispatch_stopped_intents")) return base.prepare(sql);
          const s: D1PreparedStatement = { bind: () => s, first: async () => null, all: async () => { throw new Error("unused"); },
            run: async () => { if (mode === "throw") throw new Error("synthetic-private-storage"); return { success: false, meta: { changes: 0 } }; } }; return s;
        } };
        const r = await call("operator","t","i",db); expect(r.status).toBe(503);
        expect(await r.json()).toEqual({ ok: false, code: "control_storage_unavailable" });
      }
      expect(await stops()).toEqual({ n: 0 }); expect(await held()).toEqual(before);
    });
  });
}
