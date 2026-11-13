import { describe, expect, it, vi } from "vitest";
import worker from "../../worker";
import { requestSettledEvidence } from "../../lib/settled-evidence-request";
import { exportSettledEvidence } from "../../lib/settled-evidence-export";
import { verifySettledEvidence } from "../../lib/settled-evidence";
import { observeDelegatedClaim } from "../../lib/delegated-job-recovery";
import { reconcileDelegatedBill } from "../../lib/delegated-billing";
import type { D1Database, D1PreparedStatement } from "../../lib/d1";
import type { CancellationFixture } from "./delegated-cancellation-cases";
import { recoveryCookie, recoveryEnv } from "./delegated-recovery-request-cases";
import { corruptTerminalEnrichment } from "./conflicting-terminal";

export function evidenceRequest(cookie: string, intent: string, tenant = "t", query = "", prefix = "", method = "GET") {
  return new Request(`https://gateway.test${prefix}/api/control/${tenant}/settled-evidence/${intent}${query}`,
    { method, headers: { Cookie: cookie, "X-Tenant-Id": "t", "X-Principal-Id": "google:operator", "X-Role": "owner" } });
}
export async function settleEvidenceFixture(f: CancellationFixture, reason?: string, amount = 12) {
  await observeDelegatedClaim(f.owner, f.audience, f.intentId, async () => Response.json({ jobReference: f.ref,
    configuration: { jobType: "QUERY", labels: { odap_action: f.tag }, query: { maximumBytesBilled: f.cap } },
    status: { state: "DONE", ...(reason && { errorResult: { reason } }) } }));
  await reconcileDelegatedBill(f.owner, f.audience, f.intentId, async key =>
    ({ ...key, reference: "fixture:export-total", status: "final", unit: "micro-USD", amount }));
}
export function settledEvidenceRequestCases(fixture: () => CancellationFixture) {
  const db = () => fixture().owner.db;
  const run = (sql: string) => fixture().sql(sql);
  const fetchWorker = (request: Request, database = db(), audience = fixture().audience, prefix = "") =>
    worker.fetch(request, { ...recoveryEnv(database, audience), GATEWAY_BASE_PATH: prefix }, { waitUntil: () => undefined });
  const response = async (subject = "operator", tenant = "t", intent = fixture().intentId, database = db(), audience = fixture().audience) =>
    fetchWorker(evidenceRequest(await recoveryCookie(subject), intent, tenant), database, audience);
  const denied = async (r: Response, status = 403, code = "tenant_access_denied") => {
    expect(r.status).toBe(status); expect(await r.json()).toEqual({ ok: false, code });
    expect(r.headers.get("Cache-Control")).toBe("no-store");
  };
  describe("authenticated settled evidence export", { timeout: 30000 }, () => {
    it.each(["reader", "reviewer", "inactive", "absent", "outsider"])("denies %s despite admin cookie and forged headers", async subject => {
      await run("INSERT INTO control_tenants VALUES('peer','Peer')");
      await run("INSERT INTO control_memberships VALUES('t','google:reviewer','reviewer',1),('t','google:inactive','owner',0),('peer','google:outsider','owner',1)");
      await denied(await response(subject));
    });
    it.each(["missing", "expired", "tampered"])("rejects %s authentication before storage", async kind => {
      const prepare = vi.fn(() => { throw new Error("Unexpected storage"); });
      const cookie = kind === "missing" ? "" : kind === "expired" ? await recoveryCookie("operator", Date.now()-1000) : (await recoveryCookie())+"x";
      await denied(await fetchWorker(evidenceRequest(cookie, fixture().intentId), { prepare }), 401, "unauthenticated");
      expect(prepare).not.toHaveBeenCalled();
    });
    it.each([[undefined, "succeeded", 0], ["invalidQuery", "failed", 12], ["stopped", "cancelled", 125]] as const)
      ("exports %s / %s / %i without contacting a provider or repeating accounting", async (reason, outcome, amount) => {
        const f = fixture(); await settleEvidenceFixture(f, reason, amount);
        const query = `SELECT reserved_units,spent_units,overrun_units,
          (SELECT count(*) FROM dispatch_claims) AS claims,(SELECT count(*) FROM cost_settlements) AS settlements,
          (SELECT count(*) FROM evidence_receipts) AS receipts,(SELECT count(*) FROM control_object_events) AS events
          FROM control_budgets WHERE tenant_id='t' AND id='b'`;
        const before = await f.first(query), queries: string[] = [], base = db();
        const database: D1Database = { prepare(sql) { queries.push(sql); expect(sql.trim()).toMatch(/^SELECT /); return base.prepare(sql); } };
        const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No network"));
        try {
          const request = evidenceRequest(await recoveryCookie(), f.intentId);
          const r = await fetchWorker(request, database); expect(r.status).toBe(200);
          expect(queries).toHaveLength(2);
          const body = await r.json();
          expect(body).toEqual((await requestSettledEvidence(request, recoveryEnv(db()), "t", f.intentId)).body);
          expect(body).toEqual({ ok: true, evidence: { tenantId: "t", intentId: f.intentId, audience: f.audience,
            ...await exportSettledEvidence(f.owner, f.intentId, f.audience), source: "stored-evidence",
            issuerAuthenticated: false, providerContacted: false, executionAuthorized: false, settlementAuthorized: false } });
          expect(await verifySettledEvidence(body.evidence.json, { tenantId: "t", intentId: f.intentId, audience: f.audience }, body.evidence.digest))
            .toMatchObject({ consistent: true, issuerAuthenticated: false, outcome, actualMicroUsd: amount });
          expect(JSON.parse(body.evidence.json).observation.billedBytes).toBeNull();
          expect(body.evidence.json).not.toMatch(/queryParameters|accessToken|SELECT /);
          expect(r.headers.get("Cache-Control")).toBe("no-store");
          expect(r.headers.get("X-Content-Type-Options")).toBe("nosniff");
          expect(network).not.toHaveBeenCalled(); expect(await f.first(query)).toEqual(before);
        } finally { network.mockRestore(); }
      });
    it.each(["pending", "terminal", "missing-pending-event", "missing-final-event", "conflict", "legacy-bill"])("withholds %s chains", async phase => {
      const f = fixture();
      if (phase !== "pending") await settleEvidenceFixture(f);
      // Disposable restored damage only; production history is never repaired.
      if (phase === "terminal") {
        await run("DROP TRIGGER bigquery_bill_no_delete");
        await run("DELETE FROM bigquery_billing_evidence");
      }
      if (phase.startsWith("missing-")) {
        await run("DROP TRIGGER IF EXISTS control_event_no_delete");
        await f.sql("DELETE FROM control_object_events WHERE object_kind='receipt' AND object_id=?",
          [(phase === "missing-final-event" ? "final_" : "pending_") + f.ref.jobId]);
      }
      if (phase === "conflict") await corruptTerminalEnrichment(f.sql, f.intentId);
      if (phase === "legacy-bill") {
        await run("DROP TRIGGER bigquery_bill_no_update");
        await run("UPDATE bigquery_billing_evidence SET delegation_audience=NULL,claim_body_digest=NULL,attributed_project=NULL,attributed_location=NULL");
      }
      await denied(await response());
    });
    it("does not expose another tenant or audience, even to an owner of both tenants", async () => {
      await settleEvidenceFixture(fixture());
      await run("INSERT INTO control_tenants VALUES('peer','Peer')");
      await run("INSERT INTO control_memberships VALUES('peer','google:operator','owner',1)");
      await denied(await response("operator", "peer"));
      await denied(await response("operator", "t", "missing"));
      await denied(await response("operator", "t", fixture().intentId, db(), "other-audience"));
      expect((await response()).status).toBe(200);
    });
    it("exports history after withdrawal but refuses an owner removed between authorization and snapshot", async () => {
      const f = fixture(); await settleEvidenceFixture(f); expect((await f.revoke(f.delegationId)).status).toBe(200);
      expect((await response()).status).toBe(200);
      const base = db(); let revoked = false;
      const database: D1Database = { prepare(sql) {
        const p = base.prepare(sql); if (!sql.startsWith("SELECT role FROM control_memberships")) return p;
        const wrap = (s: D1PreparedStatement): D1PreparedStatement => ({ ...s, bind: (...args) => wrap(s.bind(...args)), first: async<T>() => {
          const row = await s.first<T>(); await run("UPDATE control_memberships SET active=0 WHERE principal_id='google:operator'");
          revoked = true; return row;
        } }); return wrap(p);
      } };
      await denied(await response("operator", "t", f.intentId, database)); expect(revoked).toBe(true);
    });
    it.each(["", "bad audience"])("requires configured audience %j", async audience =>
      denied(await response("operator", "t", fixture().intentId, db(), audience), 503, "delegation_not_configured"));
    it.each(["membership", "snapshot"])("sanitizes %s storage failure", async phase => {
      const base = db(), database: D1Database = { prepare(sql) {
        if (phase === "membership" || sql.startsWith("SELECT json_object")) throw new Error("private database detail");
        return base.prepare(sql);
      } };
      await denied(await response("operator", "t", fixture().intentId, database), 503, "control_storage_unavailable");
    });
    it("refuses malformed evidence without sending a partial bundle", async () => {
      await settleEvidenceFixture(fixture()); const base = db();
      const database: D1Database = { prepare(sql) {
        const p = base.prepare(sql); if (!sql.startsWith("SELECT json_object")) return p;
        const wrap = (s: D1PreparedStatement): D1PreparedStatement => ({ ...s, bind: (...args) => wrap(s.bind(...args)), first: async<T>() => {
          const row = await s.first<T>(); return row === null ? null : { ...row, evidence: '{"private":"malformed"}' };
        } }); return wrap(p);
      } };
      await denied(await response("operator", "t", fixture().intentId, database), 503, "control_storage_unavailable");
    });
    it.each(["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])("rejects %s before storage", async method => {
      const prepare = vi.fn(() => { throw new Error("Unexpected read"); });
      const r = await fetchWorker(evidenceRequest(await recoveryCookie(), fixture().intentId, "t", "", "", method), { prepare });
      expect(r.status).toBe(405); expect(r.headers.get("Allow")).toBe("GET"); expect(prepare).not.toHaveBeenCalled();
    });
    it.each(["?refresh=true", "?audience=test-gateway", "?format=raw"])("rejects query %s before storage", async query => {
      const prepare = vi.fn(() => { throw new Error("Unexpected read"); });
      await denied(await fetchWorker(evidenceRequest(await recoveryCookie(), fixture().intentId, "t", query), { prepare }),
        400, "invalid_evidence_export"); expect(prepare).not.toHaveBeenCalled();
    });
    it.each(["bad!", "id%2Fpeer", "id%00", "id%252Fpeer", "i".repeat(129)])("rejects malformed intent %#", async intent => {
      const prepare = vi.fn(() => { throw new Error("Unexpected read"); });
      await denied(await fetchWorker(evidenceRequest(await recoveryCookie(), intent), { prepare }), 400, "invalid_control_path");
      expect(prepare).not.toHaveBeenCalled();
    });
    it("supports the mounted path and validates tenant scope", async () => {
      const f = fixture(); await settleEvidenceFixture(f); const cookie = await recoveryCookie();
      const r = await fetchWorker(evidenceRequest(cookie, f.intentId, "t", "", "/gateway"), db(), f.audience, "/gateway");
      expect(r.status).toBe(200); expect(await r.json()).toMatchObject({ evidence: { tenantId: "t", intentId: f.intentId } });
      await denied(await fetchWorker(evidenceRequest(cookie, f.intentId, "bad!")), 400, "invalid_control_path");
    });
  });
}
