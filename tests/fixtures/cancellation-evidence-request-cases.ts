import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { describe, expect, it, vi } from "vitest";
import worker from "../../worker";
import { handleCoverageToolRequest, type CoverageToolEnv } from "../../lib/coverage-mcp";
import { requestCancellationEvidence } from "../../lib/cancellation-evidence-request";
import { exportCancellationEvidence } from "../../lib/cancellation-evidence-export";
import { cancellationEvidenceMaxBytes, verifyCancellationEvidence } from "../../lib/cancellation-evidence";
import { requestDelegatedCancellation } from "../../lib/delegated-cancellation";
import { observeDelegatedClaim } from "../../lib/delegated-job-recovery";
import { serveCoverageStdio } from "../../scripts/coverage-stdio";
import { SESSION_COOKIE, signAuthPayload, type AuthSession } from "../../lib/auth";
import type { D1Database, D1PreparedStatement } from "../../lib/d1";
import type { CancellationFixture } from "./delegated-cancellation-cases";
import { recoveryCookie, recoveryEnv } from "./delegated-recovery-request-cases";

export function cancellationEvidenceRequest(cookie: string, intent: string, tenant = "t", query = "", prefix = "", method = "GET") {
  return new Request(`https://gateway.test${prefix}/api/control/${tenant}/cancellation-evidence/${intent}${query}`,
    { method, headers: { Cookie: cookie, "X-Tenant-Id": "t", "X-Principal-Id": "google:operator", "X-Role": "owner" } });
}
const call = (args: unknown, id = 51) => ({ jsonrpc: "2.0", id, method: "tools/call", params: {
  name: "odap_cancellation_evidence", arguments: args,
  _meta: { tenantId: "t", principalId: "google:operator", audience: "test-gateway", role: "owner" }
} });
export async function cancellationToolBody(request: Request, env: CoverageToolEnv, tenantId: string, intentId: string) {
  const reply = await handleCoverageToolRequest(request, env, call({ tenantId, intentId }));
  if (!("result" in reply) || !reply.result.content) throw new Error("Missing tool result");
  const body = JSON.parse(reply.result.content[0].text);
  expect(reply.id).toBe(51); expect(reply.result.isError).toBe(!body.ok); return body;
}

export function cancellationEvidenceRequestCases(fixture: () => CancellationFixture) {
  const db = () => fixture().owner.db, run = (sql: string) => fixture().sql(sql);
  const save = () => { const f = fixture(); return requestDelegatedCancellation(f.owner, f.audience, f.intentId); };
  const request = async (subject = "operator", tenant = "t", intent = fixture().intentId) =>
    cancellationEvidenceRequest(await recoveryCookie(subject), intent, tenant);
  const fetchWorker = (req: Request, database = db(), audience = fixture().audience, prefix = "") =>
    worker.fetch(req, { ...recoveryEnv(database, audience), GATEWAY_BASE_PATH: prefix }, { waitUntil: () => undefined });
  async function parity(req: Request, status: number, tenant = "t", intent = fixture().intentId, database = db(), audience = fixture().audience) {
    const env = recoveryEnv(database, audience), response = await fetchWorker(req, database, audience);
    expect(response.status).toBe(status); expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const body = await response.json();
    expect(await requestCancellationEvidence(req, env, tenant, intent)).toEqual({ status, body });
    expect(await cancellationToolBody(req, env, tenant, intent)).toEqual(body); return body;
  }
  describe("authenticated cancellation evidence transport parity", { timeout: 30000 }, () => {
    it("lists a static read-only tool without accessing storage or requiring a session", async () => {
      const prepare = vi.fn(() => { throw new Error("Unexpected storage"); });
      const reply = await handleCoverageToolRequest(new Request("https://gateway.test"), recoveryEnv({ prepare }),
        { jsonrpc: "2.0", id: 50, method: "tools/list" });
      expect(reply).toMatchObject({ result: { tools: expect.arrayContaining([expect.objectContaining({
        name: "odap_cancellation_evidence", inputSchema: { type: "object", additionalProperties: false,
          required: ["tenantId", "intentId"], properties: {
            tenantId: expect.objectContaining({ type: "string" }), intentId: expect.objectContaining({ type: "string" }) } },
        annotations: { readOnlyHint: true, openWorldHint: false }
      })]) } });
      expect(prepare).not.toHaveBeenCalled();
    });
    it("returns identical private bytes using only SELECTs without provider or accounting effects", async () => {
      const f = fixture(); await save();
      const q = `SELECT reserved_units,spent_units,overrun_units,
        (SELECT count(*) FROM bigquery_cancellation_requests) AS requests,(SELECT count(*) FROM dispatch_claims) AS claims,
        (SELECT count(*) FROM evidence_receipts) AS receipts,(SELECT count(*) FROM control_object_events) AS events
        FROM control_budgets WHERE tenant_id='t' AND id='b'`;
      const before = await f.first(q), expected = await exportCancellationEvidence(f.owner, f.audience, f.intentId), queries: string[] = [], base = db();
      const database: D1Database = { prepare(sql) { queries.push(sql); expect(sql.trim()).toMatch(/^SELECT /); return base.prepare(sql); } };
      const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No provider contact"));
      try {
        const body = await parity(await request(), 200, "t", f.intentId, database);
        expect(queries).toHaveLength(6);
        expect(body).toEqual({ ok: true, evidence: { tenantId: "t", intentId: f.intentId, audience: f.audience, ...expected,
          scope: "recorded-request-only", source: "stored-evidence", issuerAuthenticated: false, cancellationConfirmed: false,
          providerContacted: false, cancellationAuthorized: false, executionAuthorized: false, settlementAuthorized: false } });
        expect(await verifyCancellationEvidence(body.evidence.json, { tenantId: "t", intentId: f.intentId, audience: f.audience }, body.evidence.digest))
          .toMatchObject({ consistent: true, issuerAuthenticated: false, cancellationConfirmed: false });
        expect(body.evidence.json).not.toMatch(/SELECT |queryParameters|access_token|errorResult|"outcome"|actualMicroUsd/i);
        expect(network).not.toHaveBeenCalled(); expect(await f.first(q)).toEqual(before);
      } finally { network.mockRestore(); }
    });
    it.each(["reader", "reviewer", "inactive", "absent", "outsider"])("denies %s despite global-admin cookie and forged metadata", async subject => {
      await run("INSERT INTO control_tenants VALUES('peer','Peer')");
      await run("INSERT INTO control_memberships VALUES('t','google:reviewer','reviewer',1),('t','google:inactive','owner',0),('peer','google:outsider','owner',1)");
      expect(await parity(await request(subject), 403)).toEqual({ ok: false, code: "tenant_access_denied" });
    });
    it.each(["missing", "expired", "tampered", "oauth-state", "email-only"])("rejects %s authentication before storage", async kind => {
      const prepare = vi.fn(() => { throw new Error("Unexpected storage"); });
      const cookie = kind === "missing" ? "" : kind === "expired" ? await recoveryCookie("operator", Date.now()-1000) :
        kind === "tampered" ? (await recoveryCookie())+"x" : SESSION_COOKIE+"="+await signAuthPayload(kind === "oauth-state"
          ? { provider: "google", nonce: "fixture", returnTo: "/", expiresAt: Date.now()+60000 }
          : { provider: "google", email: "owner@example.test", role: "admin", expiresAt: Date.now()+60000 } as AuthSession,
        recoveryEnv({ prepare }).AUTH_COOKIE_SECRET);
      expect(await parity(cancellationEvidenceRequest(cookie, fixture().intentId), 401, "t", fixture().intentId, { prepare }))
        .toEqual({ ok: false, code: "unauthenticated" }); expect(prepare).not.toHaveBeenCalled();
    });
    it("does not cross tenants even for an owner of both, or reveal a missing request", async () => {
      const f = fixture(); await save(); await run("INSERT INTO control_tenants VALUES('peer','Peer')");
      await run("INSERT INTO control_memberships VALUES('peer','google:operator','owner',1)");
      for (const [tenant, intent] of [["peer", f.intentId], ["t", "missing"]])
        expect(await parity(await request("operator", tenant, intent), 403, tenant, intent)).toEqual({ ok: false, code: "tenant_access_denied" });
      expect(await parity(await request(), 200)).toMatchObject({ ok: true });
    });
    it.each(["", "bad audience", "other-audience"])("uses only configured audience %j", async audience => {
      await save(); const valid = audience === "other-audience";
      expect(await parity(await request(), valid ? 403 : 503, "t", fixture().intentId, db(), audience))
        .toEqual({ ok: false, code: valid ? "tenant_access_denied" : "delegation_not_configured" });
    });
    it.each(["absent", "legacy", "wrong-job", "wrong-audience", "wrong-digest", "missing-event"])("withholds %s provenance without guessing an outcome", async kind => {
      if (kind !== "absent") await save();
      if (kind === "missing-event") {
        await run("DROP TRIGGER IF EXISTS control_event_no_delete"); await run("DELETE FROM control_object_events WHERE object_kind='receipt'");
      } else if (kind !== "absent") {
        // Damage disposable fixtures only; historical production records are never repaired.
        await run("DROP TRIGGER cancellation_request_no_update");
        const changes: Record<string, string> = { legacy: "delegation_audience=NULL", "wrong-job": "job_id='wrong'",
          "wrong-audience": "delegation_audience='wrong'", "wrong-digest": "claim_body_digest='wrong'" };
        await run("UPDATE bigquery_cancellation_requests SET "+changes[kind]);
      }
      expect(await parity(await request(), 403)).toEqual({ ok: false, code: "tenant_access_denied" });
    });
    it.each(["succeeded", "failed", "cancelled"])("does not turn independent %s evidence into cancellation confirmation", async outcome => {
      const f = fixture(); await save(); const saved = await parity(await request(), 200);
      await observeDelegatedClaim(f.owner, f.audience, f.intentId, async () => Response.json({ jobReference: f.ref,
        configuration: { jobType: "QUERY", labels: { odap_action: f.tag }, query: { maximumBytesBilled: f.cap } },
        status: { state: "DONE", ...(outcome !== "succeeded" && { errorResult: { reason: outcome === "cancelled" ? "stopped" : "invalid" } }) } }));
      expect(await parity(await request(), 200)).toEqual(saved);
    });
    it("preserves requester history after grant withdrawal and owner replacement", async () => {
      const f = fixture(); await save(); const saved = await parity(await request(), 200);
      expect((await f.revoke(f.delegationId)).status).toBe(200);
      await run("UPDATE control_memberships SET active=0 WHERE principal_id='google:operator'");
      expect(await parity(await request(), 403)).toEqual({ ok: false, code: "tenant_access_denied" });
      expect(await parity(await request("owner"), 200)).toEqual(saved);
    });
    it("rechecks ownership in the snapshot after a race on each transport", async () => {
      const f = fixture(); await save(); const base = db();
      for (const mode of ["HTTP", "MCP"]) {
        await run("UPDATE control_memberships SET active=1 WHERE principal_id='google:operator'"); let revoked = false;
        const database: D1Database = { prepare(sql) {
          const p = base.prepare(sql); if (!sql.startsWith("SELECT role FROM control_memberships")) return p;
          const wrap = (s: D1PreparedStatement): D1PreparedStatement => ({ ...s, bind: (...args) => wrap(s.bind(...args)), first: async<T>() => {
            const row = await s.first<T>(); await run("UPDATE control_memberships SET active=0 WHERE principal_id='google:operator'"); revoked = true; return row;
          } }); return wrap(p);
        } };
        const req = await request(), body = mode === "HTTP" ? await (await fetchWorker(req, database)).json()
          : await cancellationToolBody(req, recoveryEnv(database), "t", f.intentId);
        expect(revoked).toBe(true); expect(body).toEqual({ ok: false, code: "tenant_access_denied" });
      }
    });
    it.each(["membership", "snapshot", "missing-table"])("sanitizes %s storage failure", async phase => {
      if (phase === "missing-table") await run("DROP TABLE bigquery_cancellation_requests");
      const base = db(), database: D1Database = { prepare(sql) {
        if (phase === "membership" || phase === "snapshot" && sql.startsWith("SELECT json_object")) throw new Error("Private storage diagnostic");
        return base.prepare(sql);
      } };
      expect(await parity(await request(), 503, "t", fixture().intentId, database)).toEqual({ ok: false, code: "control_storage_unavailable" });
    });
    it.each(["malformed", "oversized", "false-outcome"])("refuses a %s stored projection", async kind => {
      await save(); const base = db(), database: D1Database = { prepare(sql) {
        const p = base.prepare(sql); if (!sql.startsWith("SELECT json_object")) return p;
        const wrap = (s: D1PreparedStatement): D1PreparedStatement => ({ ...s, bind: (...args) => wrap(s.bind(...args)), first: async<T>() => {
          const row = await s.first<{ evidence: string }>();
          return (row === null ? null : { evidence: kind === "malformed" ? '{"private":"bad"}' : kind === "oversized"
            ? "x".repeat(cancellationEvidenceMaxBytes+1) : JSON.stringify({ ...JSON.parse(row.evidence), outcome: "cancelled" }) }) as T | null;
        } }); return wrap(p);
      } };
      expect(await parity(await request(), 503, "t", fixture().intentId, database)).toEqual({ ok: false, code: "control_storage_unavailable" });
    });
    it.each(["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])("rejects %s before storage", async method => {
      const prepare = vi.fn(() => { throw new Error("Unexpected storage"); });
      const response = await fetchWorker(cancellationEvidenceRequest(await recoveryCookie(), fixture().intentId, "t", "", "", method), { prepare });
      expect(response.status).toBe(405); expect(response.headers.get("Allow")).toBe("GET"); expect(prepare).not.toHaveBeenCalled();
    });
    it.each(["?send=true", "?audience=test-gateway", "?format=raw"])("rejects caller query %s before storage", async query => {
      const prepare = vi.fn(() => { throw new Error("Unexpected storage"); });
      expect(await parity(cancellationEvidenceRequest(await recoveryCookie(), fixture().intentId, "t", query), 400, "t", fixture().intentId, { prepare }))
        .toEqual({ ok: false, code: "invalid_evidence_export" }); expect(prepare).not.toHaveBeenCalled();
    });
    it.each(["bad!", "id%2Fpeer", "id%00", "id%252Fpeer", "x".repeat(129)])("rejects malformed scope %# before storage", async value => {
      const prepare = vi.fn(() => { throw new Error("Unexpected storage"); });
      expect(await parity(cancellationEvidenceRequest(await recoveryCookie(), value), 400, "t", value, { prepare }))
        .toEqual({ ok: false, code: "invalid_control_path" });
      expect(await parity(cancellationEvidenceRequest(await recoveryCookie(), "i", value), 400, value, "i", { prepare }))
        .toEqual({ ok: false, code: "invalid_control_path" }); expect(prepare).not.toHaveBeenCalled();
    });
    it("supports the mounted path without reading a GET body", async () => {
      const f = fixture(); await save();
      const req = cancellationEvidenceRequest(await recoveryCookie(), f.intentId, "t", "", "/gateway");
      expect((await fetchWorker(req, db(), f.audience, "/gateway")).status).toBe(200);
      Object.defineProperty(req, "body", { get: () => { throw new Error("GET body read"); } });
      expect((await requestCancellationEvidence(req, recoveryEnv(db()), "t", f.intentId)).status).toBe(200);
    });
    it("rejects extra action or authority arguments without storage", async () => {
      const prepare = vi.fn(() => { throw new Error("Unexpected storage"); }), req = await request(), env = recoveryEnv({ prepare });
      for (const args of [{}, { tenantId: "t" }, { intentId: "i" }, { tenantId: "t", intentId: 3 },
        ...["cookie", "principalId", "role", "audience", "send", "refresh", "retry", "settle", "digest", "endpoint"].map(key => ({ tenantId: "t", intentId: "i", [key]: "untrusted" }))])
        expect(await handleCoverageToolRequest(req, env, call(args))).toMatchObject({ error: { code: -32602 } });
      expect(prepare).not.toHaveBeenCalled();
    });
    it("negotiates a pipe and rereads current authority for every call", async () => {
      const f = fixture(); await save(); const req = await request(), env = recoveryEnv(db()), expected = await cancellationToolBody(req, env, "t", f.intentId);
      const input = new PassThrough(), output = new PassThrough(); let requests = 0;
      const reader = createInterface({ input: output, crlfDelay: Infinity }), lines = reader[Symbol.asyncIterator]();
      const read = async () => { const line = await lines.next(); expect(line.done).toBe(false); return JSON.parse(line.value!); };
      const write = (v: unknown) => input.write(JSON.stringify(v)+"\n");
      const serving = serveCoverageStdio(input, output, env, () => { requests++; return new Request(req); });
      try {
        const args = { tenantId: "t", intentId: f.intentId };
        write(call(args, 0)); write({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
          protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "local-request-evidence", version: "1" } } });
        write({ jsonrpc: "2.0", method: "notifications/initialized" }); write(call(args, 2));
        expect(await read()).toMatchObject({ id: 0, error: { code: -32002 } }); expect(await read()).toMatchObject({ id: 1, result: { capabilities: { tools: {} } } });
        const success = await read(); expect(success).toMatchObject({ id: 2, result: { isError: false } });
        expect(JSON.parse(success.result.content[0].text)).toEqual(expected); expect(requests).toBe(1);
        await run("UPDATE control_memberships SET active=0 WHERE principal_id='google:operator'"); write(call(args, 3));
        const denied = await read(); expect(denied).toMatchObject({ id: 3, result: { isError: true } });
        expect(JSON.parse(denied.result.content[0].text)).toEqual({ ok: false, code: "tenant_access_denied" }); expect(requests).toBe(2);
      } finally { input.end(); await serving; reader.close(); output.destroy(); }
    });
  });
}
