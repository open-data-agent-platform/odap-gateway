import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { describe, expect, it, vi } from "vitest";
import worker from "../../worker";
import { handleCoverageToolRequest, type CoverageToolEnv } from "../../lib/coverage-mcp";
import { observeDelegatedClaim } from "../../lib/delegated-job-recovery";
import { serveCoverageStdio } from "../../scripts/coverage-stdio";
import type { D1Database, D1PreparedStatement } from "../../lib/d1";
import type { CancellationFixture } from "./delegated-cancellation-cases";
import { recoveryCookie, recoveryEnv, recoveryRequest } from "./delegated-recovery-request-cases";

const call = (args: unknown, id = 37) => ({ jsonrpc: "2.0", id, method: "tools/call", params: {
  name: "odap_job_recovery", arguments: args,
  _meta: { principalId: "google:operator", role: "owner", tenantId: "t", audience: "test-gateway" }
} });
export async function recoveryToolBody(request: Request, env: CoverageToolEnv, tenantId: string, intentId: string) {
  const reply = await handleCoverageToolRequest(request,env,call({ tenantId,intentId }));
  if (!("result" in reply) || !reply.result.content) throw new Error("Expected recovery tool content");
  expect(reply.id).toBe(37);
  const body = JSON.parse(reply.result.content[0].text);
  expect(reply.result.isError).toBe(!body.ok);
  return body;
}

export function delegatedRecoveryMcpCases(fixture: () => CancellationFixture) {
  const db = () => fixture().owner.db;
  const run = (sql: string) => fixture().sql(sql);
  async function parity(request: Request, status: number, tenant = "t", intent = fixture().intentId, database = db(), audience = fixture().audience) {
    const env = recoveryEnv(database,audience), r = await worker.fetch(request,env,{ waitUntil: () => undefined });
    expect(r.status).toBe(status); expect(r.headers.get("Cache-Control")).toBe("no-store");
    const body = await r.json(); expect(await recoveryToolBody(request,env,tenant,intent)).toEqual(body); return body;
  }
  const request = async (subject = "operator", tenant = "t", intent = fixture().intentId) => recoveryRequest(await recoveryCookie(subject),intent,tenant);
  describe("stored recovery MCP policy parity", { timeout: 30000 }, () => {
    it("returns stored evidence through the same policy with no provider call", async () => {
      const network = vi.spyOn(globalThis,"fetch").mockRejectedValue(new Error("No provider network"));
      try {
        const body = await parity(await request(),200);
        expect(body).toMatchObject({ ok: true, recovery: { tenantId: "t", intentId: fixture().intentId,
          observation: null, source: "stored-evidence", providerContacted: false, executionAuthorized: false, settlementAuthorized: false } });
        expect(JSON.stringify(body)).not.toMatch(/compiled_body_digest|queryParameters|SELECT|accessToken/);
        expect(network).not.toHaveBeenCalled();
      } finally { network.mockRestore(); }
    });
    it.each([[undefined,"succeeded"],["invalidQuery","failed"],["stopped","cancelled"]] as const)
      ("returns recorded %s including stronger zero-byte evidence without causing an action", async (reason,state) => {
        const f = fixture();
        for (const bytes of [null,"0",null]) await observeDelegatedClaim(f.owner,f.audience,f.intentId,async () => Response.json({
          jobReference: f.ref, configuration: { jobType: "QUERY", labels: { odap_action: f.tag }, query: { maximumBytesBilled: f.cap } },
          status: { state: "DONE", ...(reason && { errorResult: { reason } }) },
          statistics: { query: bytes === null ? {} : { totalBytesBilled: bytes } }
        }));
        expect(await parity(await request(),200)).toMatchObject({ recovery: { observation: { state,billedBytes: 0 }, settlementAuthorized: false } });
      });
    it.each(["reader","reviewer","inactive","absent","outsider"])("denies %s regardless of signed global role and RPC metadata", async subject => {
      await run("INSERT INTO control_tenants VALUES('peer','Peer')");
      await run("INSERT INTO control_memberships VALUES('t','google:reviewer','reviewer',1),('t','google:inactive','owner',0),('peer','google:outsider','owner',1)");
      expect(await parity(await request(subject),403)).toEqual({ ok: false, code: "tenant_access_denied" });
    });
    it.each(["missing","expired","tampered"])("denies %s authentication before reading storage", async kind => {
      const prepare = vi.fn(() => { throw new Error("No storage access"); });
      const cookie = kind === "missing" ? "" : kind === "expired" ? await recoveryCookie("operator",Date.now()-1000) : (await recoveryCookie())+"x";
      expect(await parity(recoveryRequest(cookie,fixture().intentId),401,"t",fixture().intentId,{ prepare }))
        .toEqual({ ok: false, code: "unauthenticated" }); expect(prepare).not.toHaveBeenCalled();
    });
    it("does not cross tenant scope even when one principal owns both tenants", async () => {
      await run("INSERT INTO control_tenants VALUES('peer','Peer')");
      await run("INSERT INTO control_memberships VALUES('peer','google:operator','owner',1)");
      for (const [tenant,intent] of [["peer",fixture().intentId],["t","missing"]])
        expect(await parity(await request("operator",tenant,intent),403,tenant,intent)).toEqual({ ok: false, code: "tenant_access_denied" });
      expect(await parity(await request(),200)).toMatchObject({ ok: true });
    });
    it.each(["","bad audience","wrong-audience"])("uses only the server audience %j", async audience => {
      const configured = audience === "wrong-audience";
      expect(await parity(await request(),configured ? 403 : 503,"t",fixture().intentId,db(),audience))
        .toEqual({ ok: false, code: configured ? "tenant_access_denied" : "delegation_not_configured" });
    });
    it("rejects extra authority, refresh and transport arguments before storage", async () => {
      const prepare = vi.fn(() => { throw new Error("No storage access"); }), env = recoveryEnv({ prepare }), req = await request();
      for (const args of [{},{ tenantId: "t" },{ intentId: "i" },{ tenantId: "t", intentId: 3 },
        ...["principalId","role","cookie","audience","sql","endpoint","refresh","retry","settle"].map(key => ({ tenantId: "t", intentId: "i", [key]: "untrusted" }))])
        expect(await handleCoverageToolRequest(req,env,call(args))).toMatchObject({ error: { code: -32602 } });
      for (const id of ["bad!","a/b","a%2Fb","x".repeat(129)])
        expect(await recoveryToolBody(req,env,"t",id)).toEqual({ ok: false, code: "invalid_control_path" });
      expect(await recoveryToolBody(req,env,"bad!","i")).toEqual({ ok: false, code: "invalid_control_path" });
      expect(prepare).not.toHaveBeenCalled();
    });
    it("rejects unknown methods, notifications and batches without storage", async () => {
      const prepare = vi.fn(() => { throw new Error("No storage access"); }), env = recoveryEnv({ prepare }), req = await request();
      const message = call({ tenantId: "t", intentId: fixture().intentId });
      for (const value of [message.params.arguments, [message], { ...message,id: undefined }])
        expect(await handleCoverageToolRequest(req,env,value)).toMatchObject({ error: { code: -32600 } });
      expect(await handleCoverageToolRequest(req,env,{ ...message,method: "resources/write" })).toMatchObject({ error: { code: -32601 } });
      for (const params of [{ ...message.params,name: "refresh_job" },{ ...message.params,principalId: "google:operator" }])
        expect(await handleCoverageToolRequest(req,env,{ ...message,params })).toMatchObject({ error: { code: -32602 } });
      expect(prepare).not.toHaveBeenCalled();
    });
    it("lists a static read-only schema without tenant or storage inspection", async () => {
      const prepare = vi.fn(() => { throw new Error("No storage access"); });
      const reply = await handleCoverageToolRequest(recoveryRequest("","i"),recoveryEnv({ prepare }),{ jsonrpc: "2.0",id: 1,method: "tools/list" });
      if (!("result" in reply) || !reply.result.tools) throw new Error("Expected tools");
      expect(reply.result.tools.map(t => t.name)).toEqual(["odap_evidence_coverage","odap_budget_reconciliation","odap_job_recovery", "odap_settled_evidence", "odap_cancellation_evidence"]);
      expect(reply.result.tools[2]).toMatchObject({ inputSchema: { required: ["tenantId","intentId"],additionalProperties: false },
        annotations: { readOnlyHint: true,openWorldHint: false } }); expect(prepare).not.toHaveBeenCalled();
    });
    it.each(["membership","capability"])("rechecks ownership after the %s read on both transports", async phase => {
      const base = db();
      for (const transport of ["REST","MCP"]) {
        await run("UPDATE control_memberships SET active=1 WHERE principal_id='google:operator'");
        let revoked = false;
        const database: D1Database = { prepare(sql) {
          const p = base.prepare(sql);
          if (!(phase === "membership" ? sql.startsWith("SELECT role FROM control_memberships") : sql.includes("sqlite_master"))) return p;
          const wrap = (s: D1PreparedStatement): D1PreparedStatement => ({ ...s,bind: (...args) => wrap(s.bind(...args)),first: async<T>() => {
            const row = await s.first<T>(); await run("UPDATE control_memberships SET active=0 WHERE principal_id='google:operator'"); revoked = true; return row;
          } }); return wrap(p);
        } };
        const req = await request(), env = recoveryEnv(database);
        const body = transport === "MCP" ? await recoveryToolBody(req,env,"t",fixture().intentId)
          : await (await worker.fetch(req,env,{ waitUntil: () => undefined })).json();
        expect(revoked).toBe(true); expect(body).toEqual({ ok: false,code: "tenant_access_denied" });
      }
    });
    it.each(["membership","capability","snapshot"])("sanitizes %s storage failure identically", async phase => {
      const base = db(), database: D1Database = { prepare(sql) {
        if (phase === "membership" || phase === "capability" && sql.includes("sqlite_master") || phase === "snapshot" && sql.includes("SELECT j.*"))
          throw new Error("Private provider diagnostic");
        return base.prepare(sql);
      } };
      expect(await parity(await request(),503,"t",fixture().intentId,database)).toEqual({ ok: false,code: "control_storage_unavailable" });
    });
    it("does not cache capability or confuse missing storage with empty evidence", async () => {
      expect(await parity(await request(),200)).toMatchObject({ ok: true });
      await run("DROP VIEW recoverable_delegated_jobs");
      expect(await parity(await request(),503)).toEqual({ ok: false,code: "job_recovery_unavailable" });
    });
    it("refuses a refresh query in the host request instead of widening the shared policy", async () => {
      const prepare = vi.fn(() => { throw new Error("No storage access"); });
      expect(await parity(recoveryRequest(await recoveryCookie(),fixture().intentId,"t","?refresh=true"),400,"t",fixture().intentId,{ prepare }))
        .toEqual({ ok: false,code: "invalid_recovery_view" }); expect(prepare).not.toHaveBeenCalled();
    });
    it("preserves historical evidence after the original grant is withdrawn", async () => {
      expect((await fixture().revoke(fixture().delegationId)).status).toBe(200);
      expect(await parity(await request(),200)).toMatchObject({ recovery: { observation: null,executionAuthorized: false } });
    });
    it("executes only three SELECTs without changing accounting, claims, receipts or observations", async () => {
      const query = `SELECT reserved_units,spent_units,overrun_units,(SELECT count(*) FROM dispatch_claims) AS claims,
        (SELECT count(*) FROM evidence_receipts) AS receipts,(SELECT count(*) FROM bigquery_terminal_observations) AS observations,
        (SELECT count(*) FROM control_object_events) AS events,(SELECT count(*) FROM cost_settlements) AS settlements
        FROM control_budgets WHERE tenant_id='t' AND id='b'`;
      const before = await fixture().first(query), base = db(), queries: string[] = [];
      const database: D1Database = { prepare(sql) { queries.push(sql); expect(sql.trim()).toMatch(/^SELECT /); return base.prepare(sql); } };
      expect(await recoveryToolBody(await request(),recoveryEnv(database),"t",fixture().intentId)).toMatchObject({ ok: true });
      expect(queries).toHaveLength(3); expect(await fixture().first(query)).toEqual(before);
    });
    it("requires negotiation and reads fresh session authority for every call on the same pipe", async () => {
      const input = new PassThrough(), output = new PassThrough(), req = await request(); let requests = 0;
      const reader = createInterface({ input: output,crlfDelay: Infinity }); const lines = reader[Symbol.asyncIterator]();
      const read = async () => { const line = await lines.next(); expect(line.done).toBe(false); return JSON.parse(line.value!); };
      const write = (value: unknown) => input.write(JSON.stringify(value)+"\n");
      const serving = serveCoverageStdio(input,output,recoveryEnv(db()),() => { requests++; return new Request(req); });
      try {
        const args = { tenantId: "t", intentId: fixture().intentId };
        write(call(args,0));
        write({ jsonrpc: "2.0",id: 1,method: "initialize",params: { protocolVersion: "2025-06-18",capabilities: {},clientInfo: { name: "local-recovery-test",version: "1" } } });
        write({ jsonrpc: "2.0",method: "notifications/initialized" }); write(call(args,2));
        expect(await read()).toMatchObject({ id: 0,error: { code: -32002 } });
        expect(await read()).toMatchObject({ id: 1,result: { capabilities: { tools: {} } } });
        const success = await read(); expect(success).toMatchObject({ id: 2,result: { isError: false } });
        expect(JSON.parse(success.result.content[0].text)).toMatchObject({ recovery: { observation: null,providerContacted: false } });
        expect(requests).toBe(1);
        await run("UPDATE control_memberships SET active=0 WHERE principal_id='google:operator'"); write(call(args,3));
        const denied = await read(); expect(denied).toMatchObject({ id: 3,result: { isError: true } });
        expect(JSON.parse(denied.result.content[0].text)).toEqual({ ok: false,code: "tenant_access_denied" }); expect(requests).toBe(2);
      } finally { input.end(); await serving; reader.close(); output.destroy(); }
    });
  });
}
