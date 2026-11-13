import { describe, expect, it, vi } from "vitest";
import worker from "../../worker";
import { SESSION_COOKIE, signAuthPayload, type AuthSession } from "../../lib/auth";
import { requestDelegatedRecovery } from "../../lib/delegated-recovery-request";
import { observeDelegatedClaim, readDelegatedRecovery } from "../../lib/delegated-job-recovery";
import type { D1Database, D1PreparedStatement } from "../../lib/d1";
import type { CancellationFixture } from "./delegated-cancellation-cases";

const secret = "recovery-read-synthetic-cookie-key";
export async function recoveryCookie(subject = "operator", expiresAt = Date.now()+60000) {
  return SESSION_COOKIE+"="+await signAuthPayload({ provider: "google", providerId: subject, role: "admin",
    email: "owner@example.test", name: "Fixture", expiresAt },secret);
}
export const recoveryEnv = (db: D1Database, audience = "test-gateway") => ({ DB: db, AUTH_COOKIE_SECRET: secret,
  ODAP_DELEGATION_AUDIENCE: audience, ASSETS: { fetch: async () => { throw new Error("Unexpected asset fallback"); } } });
export function recoveryRequest(cookie: string, intent: string, tenant = "t", query = "", prefix = "", method = "GET") {
  return new Request(`https://gateway.test${prefix}/api/control/${tenant}/job-recovery/${intent}${query}`,
    { method, headers: { Cookie: cookie, "X-Tenant-Id": "t", "X-Principal-Id": "google:operator", "X-Role": "owner" } });
}

export function delegatedRecoveryRequestCases(fixture: () => CancellationFixture) {
  const db = () => fixture().owner.db;
  const run = (sql: string) => fixture().sql(sql);
  const fetchWorker = (request: Request, database = db(), audience = fixture().audience, prefix = "") =>
    worker.fetch(request,{ ...recoveryEnv(database,audience), GATEWAY_BASE_PATH: prefix },{ waitUntil: () => undefined });
  const response = async (subject = "operator", tenant = "t", intent = fixture().intentId, database = db(), audience = fixture().audience) =>
    fetchWorker(recoveryRequest(await recoveryCookie(subject),intent,tenant),database,audience);
  const save = async (bytes: string | null, reason?: string) => {
    const f = fixture();
    return observeDelegatedClaim(f.owner,f.audience,f.intentId,async () => Response.json({ jobReference: f.ref,
      configuration: { jobType: "QUERY", labels: { odap_action: f.tag }, query: { maximumBytesBilled: f.cap } },
      status: { state: "DONE", ...(reason && { errorResult: { reason } }) },
      statistics: { query: bytes === null ? {} : { totalBytesBilled: bytes } } }));
  };
  describe("authenticated stored-only delegated recovery", { timeout: 30000 }, () => {
    it.each(["reader","reviewer","inactive","absent","outsider"])("denies %s despite global-admin cookie and forged headers",async subject => {
      await run("INSERT INTO control_tenants VALUES('peer','Peer')");
      await run("INSERT INTO control_memberships VALUES('t','google:reviewer','reviewer',1),('t','google:inactive','owner',0),('peer','google:outsider','owner',1)");
      const r = await response(subject); expect(r.status).toBe(403);
      expect(await r.json()).toEqual({ ok: false, code: "tenant_access_denied" });
    });
    it.each(["missing","expired","tampered","oauth-state","email-only"])("rejects %s authentication before storage",async kind => {
      const prepare = vi.fn(() => { throw new Error("Unexpected storage access"); });
      const cookie = kind === "missing" ? "" : kind === "expired" ? await recoveryCookie("operator",Date.now()-1000) :
        kind === "tampered" ? (await recoveryCookie())+"x" : SESSION_COOKIE+"="+await signAuthPayload(kind === "oauth-state"
          ? { provider: "google", nonce: "fixture", returnTo: "/", expiresAt: Date.now()+60000 }
          : { provider: "google", email: "owner@example.test", role: "admin", expiresAt: Date.now()+60000 } as AuthSession,secret);
      const r = await fetchWorker(recoveryRequest(cookie,fixture().intentId),{ prepare });
      expect(r.status).toBe(401); expect(await r.json()).toEqual({ ok: false, code: "unauthenticated" });
      expect(prepare).not.toHaveBeenCalled();
    });
    it("returns the same private stored snapshot through the service and Worker without a provider call",async () => {
      const f = fixture(), request = recoveryRequest(await recoveryCookie(),f.intentId);
      const network = vi.spyOn(globalThis,"fetch").mockRejectedValue(new Error("Network disabled"));
      try {
        const r = await fetchWorker(request); expect(r.status).toBe(200);
        const body = await r.json();
        expect(body).toEqual((await requestDelegatedRecovery(request,recoveryEnv(db()),"t",f.intentId)).body);
        expect(body).toEqual({ ok: true, recovery: { tenantId: "t", intentId: f.intentId,
          ...await readDelegatedRecovery(f.owner,f.audience,f.intentId), source: "stored-evidence",
          providerContacted: false, executionAuthorized: false, settlementAuthorized: false } });
        expect(body).toMatchObject({ recovery: { jobReference: f.ref, observation: null } });
        expect(JSON.stringify(body)).not.toMatch(/compiled_body_digest|actionDigest|maximumBytesBilled|queryParameters|SELECT|accessToken/);
        expect(r.headers.get("Cache-Control")).toBe("no-store"); expect(r.headers.get("X-Content-Type-Options")).toBe("nosniff");
        expect(network).not.toHaveBeenCalled();
      } finally { network.mockRestore(); }
    });
    it.each([[undefined,"succeeded"],["invalidQuery","failed"],["stopped","cancelled"]] as const)
      ("returns recorded %s evidence without inferring billing or cancellation causation",async (reason,state) => {
        await save(null,reason);
        expect(await (await response()).json()).toMatchObject({ recovery: { observation: { state, billedBytes: null } } });
        await save("0",reason);
        const saved = await save(null,reason);
        const r = await response(); expect(r.status).toBe(200);
        expect(await r.json()).toMatchObject({ recovery: { observation: saved.observation, providerContacted: false, settlementAuthorized: false } });
        expect(saved.observation).toMatchObject({ state, billedBytes: 0 });
      });
    it("does not expose another tenant's intent even to an owner of both tenants",async () => {
      await run("INSERT INTO control_tenants VALUES('peer','Peer')");
      await run("INSERT INTO control_memberships VALUES('peer','google:operator','owner',1)");
      expect((await response()).status).toBe(200);
      for (const [tenant,intent] of [["peer",fixture().intentId],["t","missing"]]) {
        const r = await response("operator",tenant,intent); expect(r.status).toBe(403);
        expect(await r.json()).toEqual({ ok: false, code: "tenant_access_denied" });
      }
    });
    it("uses only the server audience and does not cache its scope",async () => {
      expect((await response()).status).toBe(200);
      const r = await response("operator","t",fixture().intentId,db(),"other-audience");
      expect(r.status).toBe(403); expect(await r.json()).toEqual({ ok: false, code: "tenant_access_denied" });
    });
    it.each(["","bad audience"])("requires a valid configured audience %j",async audience => {
      const r = await response("operator","t",fixture().intentId,db(),audience);
      expect(r.status).toBe(503); expect(await r.json()).toEqual({ ok: false, code: "delegation_not_configured" });
    });
    it("preserves historical recovery after delegation withdrawal without authorizing resubmission",async () => {
      const f = fixture(); expect((await f.revoke(f.delegationId)).status).toBe(200);
      const r = await response(); expect(r.status).toBe(200);
      expect(await r.json()).toMatchObject({ recovery: { observation: null, executionAuthorized: false } });
    });
    it.each(["membership","capability"])("rechecks ownership after the %s read",async phase => {
      const base = db(); let revoked = false;
      const database: D1Database = { prepare(sql) {
        const p = base.prepare(sql);
        if (!(phase === "membership" ? sql.startsWith("SELECT role FROM control_memberships") : sql.includes("sqlite_master"))) return p;
        const wrap = (s: D1PreparedStatement): D1PreparedStatement => ({ ...s, bind: (...args) => wrap(s.bind(...args)), first: async<T>() => {
          const row = await s.first<T>(); await run("UPDATE control_memberships SET active=0 WHERE principal_id='google:operator'");
          revoked = true; return row;
        } }); return wrap(p);
      } };
      const r = await response("operator","t",fixture().intentId,database); expect(revoked).toBe(true); expect(r.status).toBe(403);
      expect(await r.json()).toEqual({ ok: false, code: "tenant_access_denied" });
    });
    it.each(["membership","capability","snapshot"])("sanitizes %s storage failure",async phase => {
      const base = db();
      const database: D1Database = { prepare(sql) {
        if (phase === "membership" || phase === "capability" && sql.includes("sqlite_master") || phase === "snapshot" && sql.includes("SELECT j.*"))
          throw new Error("private storage detail");
        return base.prepare(sql);
      } };
      const r = await response("operator","t",fixture().intentId,database); expect(r.status).toBe(503);
      expect(await r.json()).toEqual({ ok: false, code: "control_storage_unavailable" });
    });
    it.each([{ billed_bytes: -1 },{ billed_bytes: 1.5 },{ outcome: "pending" },{ observed_at: "invalid" },{ observed_by: "" }])
      ("rejects malformed restored observation %# without exposing it",async patch => {
        await save("0"); const base = db();
        const database: D1Database = { prepare(sql) {
          const p = base.prepare(sql); if (!sql.includes("SELECT j.*")) return p;
          const wrap = (s: D1PreparedStatement): D1PreparedStatement => ({ ...s, bind: (...args) => wrap(s.bind(...args)), first: async<T>() => {
            const row = await s.first<T>(); return row === null ? null : Object.assign({},row,patch);
          } }); return wrap(p);
        } };
        const r = await response("operator","t",fixture().intentId,database); expect(r.status).toBe(503);
        expect(await r.json()).toEqual({ ok: false, code: "control_storage_unavailable" });
      });
    it.each(["POST","PATCH","DELETE","HEAD","OPTIONS"])("rejects %s before any storage operation",async method => {
      const prepare = vi.fn(() => { throw new Error("Unexpected read"); });
      const r = await fetchWorker(recoveryRequest(await recoveryCookie(),fixture().intentId,"t","","",method),{ prepare });
      expect(r.status).toBe(405); expect(r.headers.get("Allow")).toBe("GET"); expect(prepare).not.toHaveBeenCalled();
    });
    it.each(["?refresh=true","?audience=test-gateway","?intentId=other"])("rejects unexpected query %s before storage",async query => {
      const prepare = vi.fn(() => { throw new Error("Unexpected read"); });
      const r = await fetchWorker(recoveryRequest(await recoveryCookie(),fixture().intentId,"t",query),{ prepare });
      expect(r.status).toBe(400); expect(await r.json()).toEqual({ ok: false, code: "invalid_recovery_view" });
      expect(prepare).not.toHaveBeenCalled();
    });
    it.each(["bad!","id%2Fpeer","id%00","id%252Fpeer","i".repeat(129)])("rejects malformed intent path %#",async intent => {
      const prepare = vi.fn(() => { throw new Error("Unexpected read"); });
      const r = await fetchWorker(recoveryRequest(await recoveryCookie(),intent),{ prepare });
      expect(r.status).toBe(400); expect(await r.json()).toEqual({ ok: false, code: "invalid_control_path" });
      expect(prepare).not.toHaveBeenCalled();
    });
    it("supports /gateway and rejects malformed tenant paths",async () => {
      const cookie = await recoveryCookie(), f = fixture();
      const r = await fetchWorker(recoveryRequest(cookie,f.intentId,"t","","/gateway"),db(),f.audience,"/gateway");
      expect(r.status).toBe(200); expect(await r.json()).toMatchObject({ recovery: { tenantId: "t", intentId: f.intentId } });
      expect((await fetchWorker(recoveryRequest(cookie,f.intentId,"bad!"))).status).toBe(400);
    });
    it("does not cache schema capability or confuse a table with the recovery view",async () => {
      expect((await response()).status).toBe(200);
      await run("DROP VIEW recoverable_delegated_jobs");
      const r = await response(); expect(r.status).toBe(503);
      expect(await r.json()).toEqual({ ok: false, code: "job_recovery_unavailable" });
      await run("CREATE TABLE recoverable_delegated_jobs(id TEXT)");
      expect((await response()).status).toBe(503);
    });
    it("rejects a malformed installed view instead of presenting empty evidence",async () => {
      await run("DROP VIEW recoverable_delegated_jobs"); await run("CREATE VIEW recoverable_delegated_jobs AS SELECT 1 AS id");
      const r = await response(); expect(r.status).toBe(503);
      expect(await r.json()).toEqual({ ok: false, code: "control_storage_unavailable" });
    });
    it("executes only three SELECTs and leaves budgets, claims, receipts and audits unchanged",async () => {
      const base = db(), queries: string[] = [];
      const snapshot = `SELECT reserved_units,spent_units,overrun_units,
        (SELECT count(*) FROM dispatch_claims) AS claims,(SELECT count(*) FROM evidence_receipts) AS receipts,
        (SELECT count(*) FROM bigquery_terminal_observations) AS observations,(SELECT count(*) FROM control_object_events) AS events,
        (SELECT count(*) FROM cost_settlements) AS settlements FROM control_budgets WHERE tenant_id='t' AND id='b'`;
      const before = await fixture().first(snapshot);
      const database: D1Database = { prepare(sql) { queries.push(sql); expect(sql.trim()).toMatch(/^SELECT /); return base.prepare(sql); } };
      expect((await response("operator","t",fixture().intentId,database)).status).toBe(200); expect(queries).toHaveLength(3);
      expect(await fixture().first(snapshot)).toEqual(before);
    });
  });
}
