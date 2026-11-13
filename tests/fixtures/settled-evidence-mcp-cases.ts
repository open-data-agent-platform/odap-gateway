import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { describe, expect, it, vi } from "vitest";
import worker from "../../worker";
import { handleCoverageToolRequest, type CoverageToolEnv } from "../../lib/coverage-mcp";
import { verifySettledEvidence, settledEvidenceMaxBytes } from "../../lib/settled-evidence";
import { serveCoverageStdio } from "../../scripts/coverage-stdio";
import type { D1Database, D1PreparedStatement } from "../../lib/d1";
import type { CancellationFixture } from "./delegated-cancellation-cases";
import { recoveryCookie, recoveryEnv } from "./delegated-recovery-request-cases";
import { evidenceRequest, settleEvidenceFixture } from "./settled-evidence-request-cases";
import { corruptTerminalEnrichment } from "./conflicting-terminal";

const call = (args: unknown, id = 47) => ({ jsonrpc: "2.0", id, method: "tools/call", params: {
  name: "odap_settled_evidence", arguments: args,
  _meta: { principalId: "google:operator", role: "owner", tenantId: "t", audience: "test-gateway" }
} });
async function toolBody(request: Request, env: CoverageToolEnv, tenantId: string, intentId: string) {
  const reply = await handleCoverageToolRequest(request, env, call({ tenantId, intentId }));
  if (!("result" in reply) || !reply.result.content) throw new Error("Expected settled evidence content");
  expect(reply.id).toBe(47);
  const body = JSON.parse(reply.result.content[0].text);
  expect(reply.result.isError).toBe(!body.ok);
  return body;
}

export function settledEvidenceMcpCases(fixture: () => CancellationFixture) {
  const db = () => fixture().owner.db;
  const run = (sql: string) => fixture().sql(sql);
  const request = async (subject = "operator", tenant = "t", intent = fixture().intentId) =>
    evidenceRequest(await recoveryCookie(subject), intent, tenant);
  async function parity(req: Request, status: number, tenant = "t", intent = fixture().intentId, database = db(), audience = fixture().audience) {
    const env = recoveryEnv(database, audience), response = await worker.fetch(req, env, { waitUntil: () => undefined });
    expect(response.status).toBe(status); expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.json(); expect(await toolBody(req, env, tenant, intent)).toEqual(body); return body;
  }
  describe("settled evidence MCP policy parity", { timeout: 30000 }, () => {
    it.each([[undefined, "succeeded", 0], ["invalidQuery", "failed", 12], ["stopped", "cancelled", 125]] as const)
      ("exports %s / %s / %i as unchanged canonical bytes without network or writes", async (reason, outcome, amount) => {
        const f = fixture(); await settleEvidenceFixture(f, reason, amount);
        const query = `SELECT reserved_units,spent_units,overrun_units,
          (SELECT count(*) FROM dispatch_claims) AS claims,(SELECT count(*) FROM cost_settlements) AS settlements,
          (SELECT count(*) FROM evidence_receipts) AS receipts,(SELECT count(*) FROM control_object_events) AS events
          FROM control_budgets WHERE tenant_id='t' AND id='b'`;
        const before = await f.first(query), queries: string[] = [], base = db();
        const database: D1Database = { prepare(sql) { queries.push(sql); expect(sql.trim()).toMatch(/^SELECT /); return base.prepare(sql); } };
        const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No provider network"));
        try {
          const body = await parity(await request(), 200, "t", f.intentId, database);
          expect(queries).toHaveLength(4);
          expect(body).toMatchObject({ ok: true, evidence: { tenantId: "t", intentId: f.intentId, audience: f.audience,
            source: "stored-evidence", issuerAuthenticated: false, providerContacted: false, executionAuthorized: false, settlementAuthorized: false } });
          expect(await verifySettledEvidence(body.evidence.json, { tenantId: "t", intentId: f.intentId, audience: f.audience }, body.evidence.digest))
            .toMatchObject({ consistent: true, issuerAuthenticated: false, outcome, actualMicroUsd: amount });
          expect(JSON.parse(body.evidence.json).observation.billedBytes).toBeNull();
          expect(body.evidence.json).not.toMatch(/queryParameters|accessToken|SELECT /);
          expect(network).not.toHaveBeenCalled(); expect(await f.first(query)).toEqual(before);
        } finally { network.mockRestore(); }
      });
    it.each(["reader", "reviewer", "inactive", "absent", "outsider"])("denies %s regardless of global role or RPC metadata", async subject => {
      await run("INSERT INTO control_tenants VALUES('peer','Peer')");
      await run("INSERT INTO control_memberships VALUES('t','google:reviewer','reviewer',1),('t','google:inactive','owner',0),('peer','google:outsider','owner',1)");
      expect(await parity(await request(subject), 403)).toEqual({ ok: false, code: "tenant_access_denied" });
    });
    it.each(["missing", "expired", "tampered"])("denies %s authentication before storage", async kind => {
      const prepare = vi.fn(() => { throw new Error("Unexpected storage"); });
      const cookie = kind === "missing" ? "" : kind === "expired" ? await recoveryCookie("operator", Date.now()-1000) : (await recoveryCookie())+"x";
      expect(await parity(evidenceRequest(cookie, fixture().intentId), 401, "t", fixture().intentId, { prepare }))
        .toEqual({ ok: false, code: "unauthenticated" }); expect(prepare).not.toHaveBeenCalled();
    });
    it("does not cross tenants even for an owner of both tenants", async () => {
      await settleEvidenceFixture(fixture()); await run("INSERT INTO control_tenants VALUES('peer','Peer')");
      await run("INSERT INTO control_memberships VALUES('peer','google:operator','owner',1)");
      for (const [tenant, intent] of [["peer", fixture().intentId], ["t", "missing"]])
        expect(await parity(await request("operator", tenant, intent), 403, tenant, intent)).toEqual({ ok: false, code: "tenant_access_denied" });
      expect(await parity(await request(), 200)).toMatchObject({ ok: true });
    });
    it.each(["", "bad audience", "wrong-audience"])("uses only server audience %j", async audience => {
      await settleEvidenceFixture(fixture()); const configured = audience === "wrong-audience";
      expect(await parity(await request(), configured ? 403 : 503, "t", fixture().intentId, db(), audience))
        .toEqual({ ok: false, code: configured ? "tenant_access_denied" : "delegation_not_configured" });
    });
    it.each(["pending", "missing-bill", "missing-event", "conflict", "legacy"])("withholds %s chains without a partial bundle", async phase => {
      const f = fixture(); if (phase !== "pending") await settleEvidenceFixture(f);
      // Disposable restored damage only, never repair or rewrite production history.
      if (phase === "missing-bill") { await run("DROP TRIGGER bigquery_bill_no_delete"); await run("DELETE FROM bigquery_billing_evidence"); }
      if (phase === "missing-event") {
        await run("DROP TRIGGER IF EXISTS control_event_no_delete");
        await f.sql("DELETE FROM control_object_events WHERE object_kind='receipt' AND object_id=?", ["final_"+f.ref.jobId]);
      }
      if (phase === "conflict") await corruptTerminalEnrichment(f.sql, f.intentId);
      if (phase === "legacy") {
        await run("DROP TRIGGER bigquery_bill_no_update");
        await run("UPDATE bigquery_billing_evidence SET delegation_audience=NULL,claim_body_digest=NULL,attributed_project=NULL,attributed_location=NULL");
      }
      expect(await parity(await request(), 403)).toEqual({ ok: false, code: "tenant_access_denied" });
    });
    it("rechecks owner withdrawal between membership and snapshot on each transport", async () => {
      const f = fixture(); await settleEvidenceFixture(f); const base = db();
      for (const transport of ["REST", "MCP"]) {
        await run("UPDATE control_memberships SET active=1 WHERE principal_id='google:operator'"); let revoked = false;
        const database: D1Database = { prepare(sql) {
          const p = base.prepare(sql); if (!sql.startsWith("SELECT role FROM control_memberships")) return p;
          const wrap = (s: D1PreparedStatement): D1PreparedStatement => ({ ...s, bind: (...args) => wrap(s.bind(...args)), first: async<T>() => {
            const row = await s.first<T>(); await run("UPDATE control_memberships SET active=0 WHERE principal_id='google:operator'"); revoked = true; return row;
          } }); return wrap(p);
        } };
        const req = await request(), env = recoveryEnv(database);
        const body = transport === "MCP" ? await toolBody(req, env, "t", f.intentId)
          : await (await worker.fetch(req, env, { waitUntil: () => undefined })).json();
        expect(revoked).toBe(true); expect(body).toEqual({ ok: false, code: "tenant_access_denied" });
      }
    });
    it("preserves historical export after execution delegation withdrawal", async () => {
      const f = fixture(); await settleEvidenceFixture(f); expect((await f.revoke(f.delegationId)).status).toBe(200);
      expect(await parity(await request(), 200)).toMatchObject({ evidence: { executionAuthorized: false } });
    });
    it.each(["membership", "snapshot", "missing-table"])("sanitizes %s storage failures", async phase => {
      if (phase === "missing-table") await run("DROP TABLE bigquery_billing_evidence");
      const base = db(), database: D1Database = { prepare(sql) {
        if (phase === "membership" || phase === "snapshot" && sql.startsWith("SELECT json_object")) throw new Error("Private diagnostic");
        return base.prepare(sql);
      } };
      expect(await parity(await request(), 503, "t", fixture().intentId, database)).toEqual({ ok: false, code: "control_storage_unavailable" });
    });
    it.each(["malformed", "oversized"])("withholds %s storage responses without leaking their content", async kind => {
      await settleEvidenceFixture(fixture()); const base = db();
      const database: D1Database = { prepare(sql) {
        const p = base.prepare(sql); if (!sql.startsWith("SELECT json_object")) return p;
        const wrap = (s: D1PreparedStatement): D1PreparedStatement => ({ ...s, bind: (...args) => wrap(s.bind(...args)), first: async<T>() => {
          const row = await s.first<T>(); return row === null ? null : { ...row,
            evidence: kind === "malformed" ? '{"private":"malformed"}' : "x".repeat(settledEvidenceMaxBytes+1) };
        } }); return wrap(p);
      } };
      expect(await parity(await request(), 503, "t", fixture().intentId, database)).toEqual({ ok: false, code: "control_storage_unavailable" });
    });
    it("rejects extra authority and action arguments before storage", async () => {
      const prepare = vi.fn(() => { throw new Error("Unexpected storage"); }), env = recoveryEnv({ prepare }), req = await request();
      for (const args of [{}, { tenantId: "t" }, { intentId: "i" }, { tenantId: "t", intentId: 3 },
        ...["principalId", "role", "cookie", "audience", "sql", "endpoint", "refresh", "retry", "settle", "digest", "format"].map(key => ({ tenantId: "t", intentId: "i", [key]: "untrusted" }))])
        expect(await handleCoverageToolRequest(req, env, call(args))).toMatchObject({ error: { code: -32602 } });
      for (const id of ["bad!", "a/b", "a%2Fb", "x".repeat(129)])
        expect(await toolBody(req, env, "t", id)).toEqual({ ok: false, code: "invalid_control_path" });
      expect(await toolBody(req, env, "bad!", "i")).toEqual({ ok: false, code: "invalid_control_path" }); expect(prepare).not.toHaveBeenCalled();
    });
    it("rejects batches, notifications, unknown methods and names without storage", async () => {
      const prepare = vi.fn(() => { throw new Error("Unexpected storage"); }), env = recoveryEnv({ prepare }), req = await request();
      const message = call({ tenantId: "t", intentId: fixture().intentId });
      for (const value of [[message], { ...message, id: undefined }])
        expect(await handleCoverageToolRequest(req, env, value)).toMatchObject({ error: { code: -32600 } });
      expect(await handleCoverageToolRequest(req, env, { ...message, method: "resources/write" })).toMatchObject({ error: { code: -32601 } });
      for (const params of [{ ...message.params, name: "settle_evidence" }, { ...message.params, principalId: "google:operator" }])
        expect(await handleCoverageToolRequest(req, env, { ...message, params })).toMatchObject({ error: { code: -32602 } });
      expect(prepare).not.toHaveBeenCalled();
    });
    it("lists only static read-only schema without reading tenant data", async () => {
      const prepare = vi.fn(() => { throw new Error("Unexpected storage"); });
      const reply = await handleCoverageToolRequest(evidenceRequest("", "i"), recoveryEnv({ prepare }), { jsonrpc: "2.0", id: 1, method: "tools/list" });
      if (!("result" in reply) || !reply.result.tools) throw new Error("Expected tools");
      expect(reply.result.tools.map(t => t.name)).toEqual(["odap_evidence_coverage", "odap_budget_reconciliation", "odap_job_recovery", "odap_settled_evidence"]);
      expect(reply.result.tools[3]).toMatchObject({ inputSchema: { required: ["tenantId", "intentId"], additionalProperties: false },
        annotations: { readOnlyHint: true, openWorldHint: false } }); expect(prepare).not.toHaveBeenCalled();
    });
    it("refuses host query parameters without weakening the HTTP policy", async () => {
      const prepare = vi.fn(() => { throw new Error("Unexpected storage"); });
      expect(await parity(evidenceRequest(await recoveryCookie(), fixture().intentId, "t", "?refresh=true"), 400, "t", fixture().intentId, { prepare }))
        .toEqual({ ok: false, code: "invalid_evidence_export" }); expect(prepare).not.toHaveBeenCalled();
    });
    it("negotiates the pipe, preserves the bundle bytes and rechecks authority on the next call", async () => {
      const f = fixture(); await settleEvidenceFixture(f);
      const req = await request(), env = recoveryEnv(db()), expected = await toolBody(req, env, "t", f.intentId);
      const input = new PassThrough(), output = new PassThrough(); let requests = 0;
      const reader = createInterface({ input: output, crlfDelay: Infinity }), lines = reader[Symbol.asyncIterator]();
      const read = async () => { const line = await lines.next(); expect(line.done).toBe(false); return JSON.parse(line.value!); };
      const write = (value: unknown) => input.write(JSON.stringify(value)+"\n");
      const serving = serveCoverageStdio(input, output, env, () => { requests++; return new Request(req); });
      try {
        const args = { tenantId: "t", intentId: f.intentId };
        write(call(args, 0));
        write({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "local-export-test", version: "1" } } });
        write({ jsonrpc: "2.0", method: "notifications/initialized" }); write(call(args, 2));
        expect(await read()).toMatchObject({ id: 0, error: { code: -32002 } });
        expect(await read()).toMatchObject({ id: 1, result: { capabilities: { tools: {} } } });
        const success = await read(); expect(success).toMatchObject({ id: 2, result: { isError: false } });
        expect(JSON.parse(success.result.content[0].text)).toEqual(expected); expect(requests).toBe(1);
        await run("UPDATE control_memberships SET active=0 WHERE principal_id='google:operator'"); write(call(args, 3));
        const denied = await read(); expect(denied).toMatchObject({ id: 3, result: { isError: true } });
        expect(JSON.parse(denied.result.content[0].text)).toEqual({ ok: false, code: "tenant_access_denied" }); expect(requests).toBe(2);
      } finally { input.end(); await serving; reader.close(); output.destroy(); }
    });
  });
}
