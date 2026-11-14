import { describe, expect, it, vi } from "vitest";
import worker from "../../worker";
import { onRequestPost } from "../../functions/api/control/[tenant]/cancellation-requests";
import { readDelegatedCancellation } from "../../lib/delegated-cancellation";
import { observeDelegatedClaim } from "../../lib/delegated-job-recovery";
import { exportCancellationEvidence } from "../../lib/cancellation-evidence-export";
import type { D1Database, D1PreparedStatement } from "../../lib/d1";
import type { CancellationFixture } from "./delegated-cancellation-cases";
import { recoveryCookie, recoveryEnv } from "./delegated-recovery-request-cases";
import { inspectRecovery } from "../../lib/recovery-inspection";
import { recordReviewedCancellation, recoverReviewedCancellation } from "../../lib/owner-cancellation-request";

export function cancellationCommandRequest(cookie: string, intentId: string, tenant = "t") {
  return new Request("https://gateway.test/gateway/api/control/"+tenant+"/cancellation-requests", { method: "POST",
    headers: { Cookie: cookie, Origin: "https://gateway.test", "Content-Type": "application/json" }, body: JSON.stringify({ intentId }) });
}
export function cancellationCommandCases(fixture: () => CancellationFixture) {
  const db = () => fixture().owner.db;
  const call = async (subject = "operator", tenant = "t", intent = fixture().intentId, database = db(), audience = fixture().audience) =>
    worker.fetch(cancellationCommandRequest(await recoveryCookie(subject), intent, tenant),
      { ...recoveryEnv(database, audience), GATEWAY_BASE_PATH: "/gateway" }, { waitUntil() {} });
  const count = () => fixture().first("SELECT count(*) AS n FROM bigquery_cancellation_requests");
  const ledger = () => fixture().first("SELECT (SELECT count(*) FROM dispatch_claims) AS claims,(SELECT count(*) FROM cost_settlements) AS settlements,"+
    "(SELECT count(*) FROM evidence_receipts) AS receipts,(SELECT reserved_units FROM control_budgets WHERE tenant_id='t' AND id='b') AS reserved,"+
    "(SELECT spent_units FROM control_budgets WHERE tenant_id='t' AND id='b') AS spent");
  const finish = () => { const f = fixture(); return observeDelegatedClaim(f.owner, f.audience, f.intentId, async () => Response.json({
    jobReference: f.ref, configuration: { jobType: "QUERY", labels: { odap_action: f.tag }, query: { maximumBytesBilled: f.cap } },
    status: { state: "DONE", errorResult: { reason: "stopped" } }, statistics: { query: {} }
  })); };
  function intercept(match: (sql: string) => boolean, effect: () => Promise<void>, phase: "first" | "run" = "first"): D1Database {
    const base = db(); return { prepare(sql) {
      const statement = base.prepare(sql); if (!match(sql)) return statement;
      const wrap = (s: D1PreparedStatement): D1PreparedStatement => ({ ...s, bind: (...args) => wrap(s.bind(...args)),
        first: async<T>() => { if (phase === "first") await effect(); return s.first<T>(); },
        run: async<T>() => { if (phase === "run") await effect(); return s.run<T>(); }
      }); return wrap(statement);
    } };
  }
  describe("authenticated cancellation request command", { timeout: 30000 }, () => {
    async function browserTransport() {
      const cookie = await recoveryCookie(), env = recoveryEnv(db());
      return vi.fn<typeof fetch>(async (url, init) => {
        const headers = new Headers(init?.headers); headers.set("Cookie", cookie); headers.set("Origin", "https://gateway.test");
        return worker.fetch(new Request(new URL(String(url), "https://gateway.test"), { ...init, headers }), env, { waitUntil() {} });
      });
    }
    it("owner cancellation request workflow records and verifies stored provenance", async () => {
      const f = fixture(), send = await browserTransport(), signal = new AbortController().signal;
      const review = await inspectRecovery("t", f.intentId, signal, send); expect(review.state).toBe("ready");
      if (review.state !== "ready") throw new Error("Missing reviewed job");
      const before = await ledger(), result = await recordReviewedCancellation(review.report, signal, send);
      expect(result).toMatchObject({ state: "recorded", report: { requestedBy: f.owner.principalId, jobId: f.ref.jobId } });
      expect(await recoverReviewedCancellation(review.report, signal, send)).toEqual(result);
      expect(send.mock.calls.filter(c => c[1]?.method === "POST")).toHaveLength(1);
      expect(await count()).toEqual({ n: 1 }); expect(await ledger()).toEqual(before);
    });
    it("owner cancellation request workflow never posts after owner revocation or terminal evidence", async () => {
      const f = fixture(), send = await browserTransport(), signal = new AbortController().signal;
      const review = await inspectRecovery("t", f.intentId, signal, send);
      if (review.state !== "ready") throw new Error("Missing reviewed job");
      await f.sql("UPDATE control_memberships SET active=0 WHERE principal_id='google:operator'");
      expect(await recordReviewedCancellation(review.report, signal, send)).toEqual({ state: "denied" });
      await f.sql("UPDATE control_memberships SET active=1 WHERE principal_id='google:operator'"); await finish();
      expect(await recordReviewedCancellation(review.report, signal, send)).toEqual({ state: "ineligible" });
      expect(send.mock.calls.filter(c => c[1]?.method === "POST")).toHaveLength(0); expect(await count()).toEqual({ n: 0 });
    });
    it("owner cancellation request workflow recovers a lost acknowledgement without posting again", async () => {
      const f = fixture(), send = await browserTransport(), signal = new AbortController().signal;
      const review = await inspectRecovery("t", f.intentId, signal, send);
      if (review.state !== "ready") throw new Error("Missing reviewed job");
      const lost = vi.fn<typeof fetch>(async (url, init) => {
        const response = await send(url, init); if (init?.method === "POST") throw new Error("Lost response"); return response;
      });
      expect(await recordReviewedCancellation(review.report, signal, lost)).toEqual({ state: "unknown" });
      expect(await count()).toEqual({ n: 1 });
      expect(await recoverReviewedCancellation(review.report, signal, send)).toMatchObject({ state: "recorded", report: { requestedBy: f.owner.principalId } });
      expect(send.mock.calls.filter(c => c[1]?.method === "POST")).toHaveLength(1); expect(await count()).toEqual({ n: 1 });
    });
    it("records one explicit request without provider contact or accounting changes", async () => {
      const f = fixture(), before = await ledger(), network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No network"));
      try {
        const response = await call(); expect(response.status).toBe(200);
        const state = await readDelegatedCancellation(f.owner, f.audience, f.intentId);
        const body = await response.json();
        expect(body).toEqual({ ok: true, cancellationRequest: { tenantId: "t", intentId: f.intentId,
          requestedBy: f.owner.principalId, requestedAt: state.request?.requestedAt, scope: "recorded-request-only",
          providerContacted: false, cancellationConfirmed: false, cancellationAuthorized: false, executionAuthorized: false, settlementAuthorized: false } });
        expect(response.headers.get("Cache-Control")).toBe("no-store");
        expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
        expect(await ledger()).toEqual(before); expect(await count()).toEqual({ n: 1 }); expect(network).not.toHaveBeenCalled();
        expect(await exportCancellationEvidence(f.owner, f.audience, f.intentId)).not.toBeNull();
        const direct = await onRequestPost({ request: cancellationCommandRequest(await recoveryCookie(), f.intentId), env: recoveryEnv(db()), params: { tenant: "t" } });
        expect(await direct.json()).toEqual(body);
      } finally { network.mockRestore(); }
    });
    it("preserves the first requester and time across concurrent owners and retries", async () => {
      const [a, b] = await Promise.all([call(), call("owner")]); expect(a.status).toBe(200); expect(b.status).toBe(200);
      const body = await a.json(); expect(await b.json()).toEqual(body); expect(await (await call()).json()).toEqual(body);
      expect(await count()).toEqual({ n: 1 });
    });
    it("permits current-owner recovery after grant withdrawal but never rewrites the original requester", async () => {
      const f = fixture(); expect((await f.revoke(f.delegationId)).status).toBe(200);
      const body = await (await call()).json();
      await f.sql("UPDATE control_memberships SET active=0 WHERE principal_id='google:operator'");
      expect((await call()).status).toBe(403); expect(await (await call("owner")).json()).toEqual(body);
      expect(await count()).toEqual({ n: 1 });
    });
    it.each(["reader", "reviewer", "inactive", "absent", "outsider"])("denies %s without saving a request", async subject => {
      const f = fixture(); await f.sql("INSERT INTO control_tenants VALUES('peer','Peer')");
      await f.sql("INSERT INTO control_memberships VALUES('t','google:reviewer','reviewer',1),('t','google:inactive','owner',0),('peer','google:outsider','owner',1)");
      expect((await call(subject)).status).toBe(403); expect(await count()).toEqual({ n: 0 });
    });
    it("binds the intent to its tenant even for an owner of both tenants", async () => {
      const f = fixture(); await f.sql("INSERT INTO control_tenants VALUES('peer','Peer')");
      await f.sql("INSERT INTO control_memberships VALUES('peer','google:operator','owner',1)");
      for (const [tenant, intent] of [["peer", f.intentId], ["t", "absent"]]) {
        const response = await call("operator", tenant, intent); expect(response.status).toBe(403);
        expect(await response.json()).toEqual({ ok: false, code: "tenant_access_denied" });
      }
      expect(await count()).toEqual({ n: 0 });
    });
    it("uses only the configured audience", async () => {
      const r = await call("operator", "t", fixture().intentId, db(), "other");
      expect(r.status).toBe(403); expect(await count()).toEqual({ n: 0 });
    });
    it.each(["snapshot", "write"])("rechecks revoked ownership at %s", async phase => {
      const database = intercept(sql => phase === "snapshot" ? sql.startsWith("SELECT j.*") : sql.startsWith("INSERT INTO bigquery_cancellation_requests"),
        async () => { await fixture().sql("UPDATE control_memberships SET active=0 WHERE principal_id='google:operator'"); }, phase === "write" ? "run" : "first");
      const r = await call("operator", "t", fixture().intentId, database);
      expect(r.status).toBe(phase === "snapshot" ? 403 : 503); expect(await count()).toEqual({ n: 0 });
    });
    it.each(["before", "during-write"])("does not create a late request when a terminal observation wins %s", async phase => {
      if (phase === "before") await finish();
      const before = await ledger(), database = phase === "before" ? db() :
        intercept(sql => sql.startsWith("INSERT INTO bigquery_cancellation_requests"), async () => { await finish(); }, "run");
      const r = await call("operator", "t", fixture().intentId, database); expect(r.status).toBe(409);
      expect(await r.json()).toEqual({ ok: false, code: "cancellation_request_unavailable" });
      expect(await count()).toEqual({ n: 0 }); expect(await ledger()).toEqual(before);
    });
    it("acknowledges an existing request after a terminal observation without claiming cancellation", async () => {
      const saved = await (await call()).json(); await finish(); expect(await (await call()).json()).toEqual(saved);
      expect(await count()).toEqual({ n: 1 });
    });
    it("does not upgrade or overwrite an unattributed legacy request", async () => {
      const f = fixture(); await f.sql("DROP TRIGGER delegated_cancellation_guard");
      await f.sql("INSERT INTO bigquery_cancellation_requests(tenant_id,intent_id,job_id,requested_by) VALUES('t',?,?,'google:operator')", [f.intentId, f.ref.jobId]);
      const before = await f.first("SELECT * FROM bigquery_cancellation_requests");
      const r = await call(); expect(r.status).toBe(409);
      expect(await f.first("SELECT * FROM bigquery_cancellation_requests")).toEqual(before);
    });
    it.each(["membership", "snapshot", "write"])("sanitizes %s storage errors without recording success", async phase => {
      const base = db(), database: D1Database = { prepare(sql) {
        if (phase === "membership" && sql.startsWith("SELECT role") || phase === "snapshot" && sql.startsWith("SELECT j.*") ||
            phase === "write" && sql.startsWith("INSERT INTO bigquery_cancellation_requests")) throw new Error("Private storage diagnostic");
        return base.prepare(sql);
      } };
      const r = await call("operator", "t", fixture().intentId, database);
      expect(r.status).toBe(503); expect(await r.json()).toEqual({ ok: false, code: "control_storage_unavailable" });
      expect(await count()).toEqual({ n: 0 });
    });
    it("does not claim success on an unconfirmed write", async () => {
      const base = db(), database: D1Database = { prepare(sql) {
        const s = base.prepare(sql); if (!sql.startsWith("INSERT INTO bigquery_cancellation_requests")) return s;
        const wrap = (p: D1PreparedStatement): D1PreparedStatement => ({ ...p, bind: (...args) => wrap(p.bind(...args)), run: async () => ({ success: false }) });
        return wrap(s);
      } };
      const r = await call("operator", "t", fixture().intentId, database); expect(r.status).toBe(503); expect(await count()).toEqual({ n: 0 });
    });
    it("recovers a saved request after its first response read fails", async () => {
      let reads = 0;
      const database = intercept(sql => sql.startsWith("SELECT r.requested_by"), async () => { if (++reads === 2) throw new Error("Private readback failure"); });
      const r = await call("operator", "t", fixture().intentId, database); expect(r.status).toBe(503);
      expect(await r.json()).toEqual({ ok: false, code: "control_storage_unavailable" }); expect(await count()).toEqual({ n: 1 });
      const saved = await (await call()).json(); expect(saved).toMatchObject({ ok: true, cancellationRequest: { cancellationConfirmed: false } });
      expect(await count()).toEqual({ n: 1 });
    });
  });
}
