import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_COOKIE, signAuthPayload } from "../lib/auth";
import { createPostgresGateway } from "../integrations/postgresql/gateway";
import { jobSqlite, jobTransactionalDatabase } from "./fixtures/job-sqlite";
import { approvePostgresFixture, pgAccess, pgAction, pgRun, publishPostgresFixture, seedPostgresControl } from "./fixtures/postgresql-control";
import { claimPostgresRead, preparePostgresDispatch } from "../lib/postgresql-control";
import { approvePostgresAgentFixture } from "./fixtures/postgresql-agent";
import { postgresBarrier } from "./fixtures/postgresql";

let dir: string;
const db = () => jobTransactionalDatabase(() => join(dir, "control.db"));
const resolver = vi.fn(async () => { throw new Error("No provider connection in transport tests"); });
const secret = "synthetic-postgresql-cookie-test";
async function cookie(principal: string) {
  return SESSION_COOKIE + "=" + await signAuthPayload({ provider: "google", providerId: principal,
    email: "synthetic@example.test", name: "Synthetic", role: "admin", expiresAt: Date.now() + 600000 }, secret);
}
async function call(command: string, input: unknown, principal = "reader", tenant = "tenant-a", mcp = false) {
  return createPostgresGateway({ origin: "https://gateway.test", env: { DB: db(), AUTH_COOKIE_SECRET: secret }, resolve: resolver })(
    new Request(`https://gateway.test/postgresql/${tenant}/${mcp ? "mcp" : command}`, { method: "POST",
      headers: { Origin: "https://gateway.test", "Content-Type": "application/json", Cookie: await cookie(principal) },
      body: JSON.stringify(mcp ? { jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "postgresql_" + command.replaceAll("-", "_"), arguments: input } } : input) }));
}
describe("authenticated PostgreSQL REST/MCP host hook", { timeout: 30000 }, () => {
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "odap-pg-http-")); resolver.mockClear();
    await jobSqlite(join(dir, "control.db"), "setup");
    await seedPostgresControl(db()); await publishPostgresFixture(db());
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it.each([false, true])("exports owner-bound evidence through the shared command without provider access (MCP=%s)", async mcp => {
    const database = db(); await approvePostgresFixture(database);
    const { row } = await preparePostgresDispatch(pgAccess(database), "request");
    expect(await claimPostgresRead(pgAccess(database), row, "intent")).toBe(true);
    const denied = await (await call("export-evidence", { requestId: "request" }, "reader", "tenant-a", mcp)).json();
    expect(mcp ? denied.result.isError : denied.ok).toBe(mcp ? true : false);
    const response = await call("export-evidence", { requestId: "request" }, "owner", "tenant-a", mcp), body = await response.json();
    expect(response.status).toBe(200);
    const bundle = mcp ? JSON.parse(body.result.content[0].text) : body.result;
    expect(JSON.parse(bundle.json).intentId).toBe("intent"); expect(bundle.digest).toMatch(/^sha256:/);
    expect(resolver).not.toHaveBeenCalled();
  });

  it.each([false, true])("shares host admission across session and Agent while keeping control commands available (MCP=%s)", async mcp => {
    const database = db(); await approvePostgresFixture(database);
    const agent = await approvePostgresAgentFixture(database);
    const entered = postgresBarrier(), release = postgresBarrier();
    const resolve = vi.fn(async () => { entered.resolve(); await release.promise; throw new Error("synthetic-preparation-failure"); });
    const handler = createPostgresGateway({ origin: "https://gateway.test", env: { DB: database, AUTH_COOKIE_SECRET: secret },
      resolve, maxConcurrentExecutions: 1 });
    const session = async (command: string) => handler(new Request(`https://gateway.test/postgresql/tenant-a/${mcp ? "mcp" : command}`, {
      method: "POST", headers: { Origin: "https://gateway.test", "Content-Type": "application/json", Cookie: await cookie("reader") },
      body: JSON.stringify(mcp ? { jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "postgresql_" + command, arguments: { requestId: "request" } } } : { requestId: "request" }),
    }));
    const pending = session("execute");
    try {
      await entered.promise;
      const busy = await session("execute"), body = await busy.json();
      expect(mcp ? body.result.isError : busy.status).toBe(mcp ? true : 429);
      if (mcp) expect(body.result.content[0].text).toContain("no execution was admitted");
      const args = { delegationId: agent.delegationId, signature: agent.signature };
      const agentResponse = await handler(new Request(`https://gateway.test/postgresql/tenant-a/${mcp ? "agent-mcp" : "agent-execute"}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(mcp ? {
          jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "postgresql_agent_execute", arguments: args },
        } : args),
      }));
      expect(agentResponse.status).toBe(429);
      expect(await agentResponse.json()).toEqual({ ok: false, code: "postgresql_host_busy" });
      const inspection = await (await session("inspect")).json();
      expect(mcp ? inspection.result.isError : inspection.ok).toBe(!mcp);
      const stopped = await (await session("stop")).json();
      expect(mcp ? stopped.result.isError : stopped.ok).toBe(!mcp);
      expect(resolve).toHaveBeenCalledOnce();
      expect(await database.prepare("SELECT COUNT(*) AS n FROM postgresql_read_claims").bind().first()).toEqual({ n: 0 });
    } finally { release.resolve(); await pending; }
  });

  it.each([false, true])("binds request and approval to current session identities (MCP=%s)", async mcp => {
    const input = { requestId: "request", releaseId: "release", action: pgAction };
    expect((await call("request", input, "reader", "tenant-a", mcp)).status).toBe(200);
    const approval = { requestId: "request", releaseId: "release", sourceId: "revision-1", requesterId: "google:reader", reviewedAction: pgAction };
    const denied = await (await call("approve-read", approval, "other-owner", "tenant-a", mcp)).json();
    expect(mcp ? denied.result.isError : denied.ok).toBe(mcp);
    const approved = await (await call("approve-read", approval, "owner", "tenant-a", mcp)).json();
    expect(mcp ? approved.result.isError : approved.ok).toBe(!mcp);
    const inspect = await (await call("inspect", { requestId: "request" }, "reader", "tenant-a", mcp)).json();
    const result = mcp ? JSON.parse(inspect.result.content[0].text) : inspect.result;
    expect(result.requester_id).toBe("google:reader"); expect(result.contract_id).toBeTruthy();
    expect(resolver).not.toHaveBeenCalled();
  });

  it.each([false, true])("rejects caller-supplied authority and receipt outcomes (MCP=%s)", async mcp => {
    for (const [command, input] of [
      ["request", { requestId: "request", releaseId: "release", action: pgAction, principalId: "google:owner" }],
      ["execute", { requestId: "request", permissionGranted: true }],
      ["observe", { requestId: "request", outcome: "succeeded" }],
      ["register-source", { host: "business-db.example.test" }],
      ["cancel", { requestId: "request", pid: 123 }],
    ] as const) {
      const body = await (await call(command, input, "reader", "tenant-a", mcp)).json();
      expect(mcp ? body.result.isError : body.ok).toBe(mcp);
    }
    expect(resolver).not.toHaveBeenCalled();
  });

  it("refuses unauthenticated, cross-origin and inactive sessions before resolver access", async () => {
    const handler = createPostgresGateway({ origin: "https://gateway.test", env: { DB: db(), AUTH_COOKIE_SECRET: secret }, resolve: resolver });
    for (const [headers, status] of [
      [{ Origin: "https://gateway.test", "Content-Type": "application/json" }, 401],
      [{ Origin: "https://evil.test", "Content-Type": "application/json", Cookie: await cookie("reader") }, 403],
    ] as const) expect((await handler(new Request("https://gateway.test/postgresql/tenant-a/execute", {
      method: "POST", headers, body: JSON.stringify({ requestId: "request" }),
    }))).status).toBe(status);
    await pgRun(db(), "UPDATE control_memberships SET active=0 WHERE tenant_id='tenant-a' AND principal_id='google:reader'");
    expect((await call("execute", { requestId: "request" })).status).toBe(403);
    expect(resolver).not.toHaveBeenCalled();
  });

  it("does not leak provider errors or choose a provider before durable approval", async () => {
    expect((await call("execute", { requestId: "missing" })).status).toBe(409);
    expect(resolver).not.toHaveBeenCalled();
  });

  it("lists MCP tools with omitted params and exposes no caller-authority or observation tool", async () => {
    const handler = createPostgresGateway({ origin: "https://gateway.test", env: { DB: db(), AUTH_COOKIE_SECRET: secret }, resolve: resolver });
    const response = await handler(new Request("https://gateway.test/postgresql/tenant-a/mcp", { method: "POST",
      headers: { Origin: "https://gateway.test", "Content-Type": "application/json", Cookie: await cookie("reader") },
      body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list" }) }));
    const body = await response.json();
    expect(body.result.tools).toHaveLength(17);
    expect(body.result.tools.map((t: { name: string }) => t.name)).not.toContain("postgresql_observe");
    expect(body.result.tools.find((t: { name: string }) => t.name === "postgresql_execute").inputSchema)
      .toEqual({ type: "object", properties: { requestId: { type: "string" } }, required: ["requestId"], additionalProperties: false });
    expect(resolver).not.toHaveBeenCalled();
  });

  it.each([false, true])("exposes authorized cancellation intent without provider access (MCP=%s)", async mcp => {
    const database = db(); await approvePostgresFixture(database);
    const { row } = await preparePostgresDispatch(pgAccess(database), "request"); await claimPostgresRead(pgAccess(database), row, "one");
    const denied = await (await call("cancel", { requestId: "request" }, "other-owner", "tenant-a", mcp)).json();
    expect(mcp ? denied.result.isError : denied.ok).toBe(mcp);
    const body = await (await call("cancel", { requestId: "request" }, "reader", "tenant-a", mcp)).json();
    expect(mcp ? JSON.parse(body.result.content[0].text) : body.result).toMatchObject({ status: "cancellation-requested", cancellationConfirmed: false });
    expect(resolver).not.toHaveBeenCalled();
  });
});
