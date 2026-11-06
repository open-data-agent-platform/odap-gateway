import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import worker from "../worker";
import { SESSION_COOKIE, signAuthPayload } from "../lib/auth";
import { handleCoverageToolRequest } from "../lib/coverage-mcp";
import { inspectCoverage } from "../lib/coverage-inspection";
import { jobDatabase, jobSqlite } from "./fixtures/job-sqlite";

let dir: string, file: string;
const db = jobDatabase(() => file, "readonly");
const secret = "coverage-parity-synthetic-cookie-key";
const env = { DB: db, AUTH_COOKIE_SECRET: secret, ASSETS: { fetch: async () => { throw new Error("Unexpected asset lookup"); } } };
const sql = (q: string) => jobSqlite(file, "run", q);
const call = (args: unknown) => ({ jsonrpc: "2.0", id: 31, method: "tools/call", params: {
  name: "odap_evidence_coverage", arguments: args, _meta: { tenantId: "t", principalId: "google:owner", role: "owner" }
} });
async function session(subject: string, ttl = 60_000) {
  return SESSION_COOKIE + "=" + await signAuthPayload({ provider: "google", providerId: subject, name: "Fixture",
    email: "synthetic@example.test", expiresAt: Date.now() + ttl }, secret);
}
function req(tenant: string, cookie: string, method = "GET") {
  return new Request("https://gateway.test/api/control/" + tenant + "/evidence-coverage", { method,
    headers: { Cookie: cookie, "X-Tenant-Id": "t", "X-Principal-Id": "google:owner", "X-Role": "owner" } });
}
const rest = (request: Request, bindings = env) => worker.fetch(request, bindings, { waitUntil: () => undefined });
async function toolBody(request: Request, tenantId: string, bindings = env) {
  const response = await handleCoverageToolRequest(request, bindings, call({ tenantId }));
  if (!("result" in response) || !response.result.content) throw new Error("Expected a tool result");
  const body = JSON.parse(response.result.content[0].text);
  expect(response.id).toBe(31);
  expect(response.result.isError).toBe(!body.ok);
  return body;
}

describe("REST and in-process MCP coverage policy", () => {
  beforeAll(async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network disabled"));
    dir = await mkdtemp(join(tmpdir(), "odap-coverage-parity-"));
    file = join(dir, "fixture.db");
    await jobSqlite(file, "setup");
    await sql("INSERT INTO control_tenants VALUES ('peer','Peer')");
    await sql(`INSERT INTO control_memberships VALUES
      ('t','google:owner','owner',1),('t','google:reader','reader',1),('t','google:reviewer','reviewer',1),
      ('t','google:inactive','owner',0),('t','google:subject','reader',1),('peer','google:subject','owner',1),
      ('t','google:changing','owner',1)`);
  });
  afterAll(async () => {
    try { expect(globalThis.fetch).not.toHaveBeenCalled(); }
    finally { vi.restoreAllMocks(); if (dir) await rm(dir, { recursive: true, force: true }); }
  });

  it.each([
    ["owner", "t", 200, ""], ["subject", "peer", 200, ""], ["subject", "t", 403, "tenant_access_denied"],
    ["owner", "peer", 403, "tenant_access_denied"], ["reader", "t", 403, "tenant_access_denied"],
    ["reviewer", "t", 403, "tenant_access_denied"], ["inactive", "t", 403, "tenant_access_denied"],
    ["absent", "t", 403, "tenant_access_denied"], ["", "t", 401, "unauthenticated"],
    ["expired", "t", 401, "unauthenticated"], ["owner", "invalid!", 400, "invalid_control_path"]
  ] as const)("returns the same policy result for %s in %s (%i)", async (subject, tenant, status, code) => {
    const cookie = subject === "expired" ? await session("owner", -1000) : subject ? await session(subject) : "";
    const r = await rest(req(tenant,cookie));
    expect(r.status).toBe(status);
    expect(r.headers.get("Cache-Control")).toBe("no-store");
    const body = await r.json();
    expect(await toolBody(req(tenant,cookie),tenant)).toEqual(body);
    const n = tenant === "t" ? 1 : 0;
    expect(body).toEqual(status !== 200 ? { ok: false, code } : { ok: true, coverage: {
      admitted: n, recordedAttempts: n, missingEvidence: n, pendingOutcome: 0, pendingBilling: 0,
      attributedSettlements: 0, unattributedSettlements: 0, missingReleaseRefusals: 0
    } });
  });

  it("maps real Worker counts, empty tenants and denials to distinct UI states", async () => {
    async function inspect(tenant: string, subject?: string) {
      const cookie = subject ? await session(subject) : "";
      return inspectCoverage(tenant, new AbortController().signal, (path,init) =>
        rest(new Request(new URL(String(path),"https://gateway.test"), { ...init, headers: { Cookie: cookie } })));
    }
    expect(await inspect("t","owner")).toMatchObject({ state:"ready",report:{ recordedAttempts:1,missingEvidence:1 } });
    expect(await inspect("peer","subject")).toMatchObject({ state:"ready",report:{ recordedAttempts:0 } });
    expect(await inspect("t","subject")).toEqual({ state:"denied" });
    expect(await inspect("t")).toEqual({ state:"unauthenticated" });
  });

  it.each(["REST","MCP"])("rechecks ownership at snapshot time on %s", async transport => {
    await sql("UPDATE control_memberships SET active=1 WHERE principal_id='google:changing'");
    let revoked = false;
    const hooked: typeof db = { prepare(q) {
      const p = db.prepare(q);
      if (!q.startsWith("SELECT role FROM control_memberships")) return p;
      return { ...p, bind(...args) {
        const stmt = p.bind(...args);
        return { ...stmt, async first<T>() {
          const row = await stmt.first<T>();
          await sql("UPDATE control_memberships SET active=0 WHERE principal_id='google:changing'");
          revoked = true;
          return row;
        } };
      } };
    } };
    const request = req("t",await session("changing"));
    const bindings = { ...env, DB: hooked };
    const expected = { ok: false, code: "tenant_access_denied" };
    if (transport === "REST") {
      const r = await rest(request, bindings);
      expect(r.status).toBe(403);
      expect(await r.json()).toEqual(expected);
    } else expect(await toolBody(request,"t",bindings)).toEqual(expected);
    expect(revoked).toBe(true);
  });

  it("lists only the count tool and rejects impersonation, arbitrary tools and write methods", async () => {
    const request = req("t",await session("owner"));
    const run = (message: unknown) => handleCoverageToolRequest(request,env,message);
    const listed = await run({ jsonrpc:"2.0", id:"list", method:"tools/list" });
    if (!("result" in listed) || !listed.result.tools) throw new Error("Expected a tool list");
    expect(listed.result.tools.map(t => t.name)).toEqual(["odap_evidence_coverage"]);
    for (const args of [{}, { tenantId:"t", principalId:"google:owner" }, { tenantId:"t", sql:"SELECT 1" }])
      expect(await run(call(args))).toMatchObject({ error:{ code:-32602 } });
    expect(await run({ ...call({}), params:{ name:"run_query", arguments:{} } })).toMatchObject({ error:{ code:-32602 } });
    expect(await run({ ...call({}), method:"resources/read" })).toMatchObject({ error:{ code:-32601 } });
    expect(await run([call({tenantId:"t"})])).toMatchObject({ id:null, error:{ code:-32600 } });
    const r = await rest(req("t",await session("owner"),"POST"));
    expect(r.status).toBe(405);
  });
  it("fails closed without exposing a storage diagnostic through either interface", async () => {
    const bindings = { ...env, DB: { prepare() { throw new Error("private fixture detail"); } } };
    const request = req("t",await session("owner"));
    const r = await rest(request,bindings);
    expect(r.status).toBe(503);
    const expected = { ok:false, code:"control_storage_unavailable" };
    expect(await r.json()).toEqual(expected);
    expect(await toolBody(request,"t",bindings)).toEqual(expected);
  });
});
