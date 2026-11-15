import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_COOKIE, signAuthPayload } from "../lib/auth";
import { createPostgresGateway } from "../integrations/postgresql/gateway";
import { jobSqlite, jobTransactionalDatabase } from "./fixtures/job-sqlite";
import { pgAccess, pgAction, publishPostgresFixture, seedPostgresControl } from "./fixtures/postgresql-control";
import { approvePostgresAgentFixture, enrollPostgresAgent, pgAgentOrigin } from "./fixtures/postgresql-agent";
import { revokePostgresDelegation } from "../lib/postgresql-agent";

let dir: string;
const db = () => jobTransactionalDatabase(() => join(dir, "control.db"));
const resolve = vi.fn(async () => { throw new Error("Synthetic resolver fault, never exposed"); });
const secret = "synthetic-postgresql-agent-session";
async function session(command: string, input: unknown, principal = "reader", mcp = false) {
  const cookie = SESSION_COOKIE + "=" + await signAuthPayload({ provider: "google", providerId: principal,
    email: "synthetic@example.test", name: "Synthetic", role: "admin", expiresAt: Date.now() + 600000 }, secret);
  return createPostgresGateway({ origin: pgAgentOrigin, env: { DB: db(), AUTH_COOKIE_SECRET: secret }, resolve })(
    new Request(`${pgAgentOrigin}/postgresql/tenant-a/${mcp ? "mcp" : command}`, { method: "POST",
      headers: { Origin: pgAgentOrigin, "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify(mcp ? { jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "postgresql_" + command.replaceAll("-", "_"), arguments: input } } : input) }));
}
async function agent(operation: string, args: unknown, mcp = false, headers: Record<string, string> = {}, tenant = "tenant-a") {
  return createPostgresGateway({ origin: pgAgentOrigin, env: { DB: db() }, resolve })(
    new Request(`${pgAgentOrigin}/postgresql/${tenant}/${mcp ? "agent-mcp" : "agent-" + operation}`, { method: "POST",
      headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(mcp ? {
        jsonrpc: "2.0", id: "agent", method: "tools/call", params: { name: "postgresql_agent_" + operation, arguments: args },
      } : args) }));
}
describe("signed PostgreSQL Agent REST/MCP", { timeout: 30000 }, () => {
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "odap-pg-agent-http-")); resolve.mockClear();
    await jobSqlite(join(dir, "control.db"), "setup"); await seedPostgresControl(db()); await publishPostgresFixture(db());
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
  it.each([false, true])("runs consent, exact owner review and challenge acquisition through the shared human service (MCP=%s)", async mcp => {
    await enrollPostgresAgent(db());
    const unpack = async (r: Response) => { const b = await r.json(); expect(r.status).toBe(200); return mcp ? JSON.parse(b.result.content[0].text) : b.result; };
    await unpack(await session("request", { requestId: "request", releaseId: "release", action: pgAction }, "reader", mcp));
    const d = await unpack(await session("delegate", { requestId: "request", agentId: "agent-one", keyId: "key-one" }, "reader", mcp));
    await unpack(await session("approve-agent-read", { requestId: "request", releaseId: "release", sourceId: "revision-1",
      requesterId: "google:reader", reviewedAction: pgAction, delegationId: d.delegationId, agentId: "agent-one", keyId: "key-one" }, "owner", mcp));
    const challenges = await unpack(await session("agent-challenges", { delegationId: d.delegationId }, "reader", mcp));
    expect(JSON.parse(challenges.execute)).toMatchObject({ audience: pgAgentOrigin, agentId: "agent-one", requesterId: "google:reader" });
    const blocked = await (await session("execute", { requestId: "request" }, "reader", mcp)).json();
    expect(mcp ? blocked.result.isError : blocked.ok).toBe(mcp);
    await unpack(await session("revoke-delegation", { delegationId: d.delegationId }, "reader", mcp));
    expect(resolve).not.toHaveBeenCalled();
  });
  it.each([false, true])("accepts signed read-only recovery without a browser identity and rejects forged authority (MCP=%s)", async mcp => {
    const a = await approvePostgresAgentFixture(db());
    const args = { delegationId: a.delegationId, signature: a.inspectSignature };
    const response = await agent("inspect", args, mcp); expect(response.status).toBe(200);
    const body = await response.json(); const result = mcp ? JSON.parse(body.result.content[0].text) : body.result;
    expect(result).toMatchObject({ state: "not-submitted", agentId: "agent-one" });
    for (const invalid of [{ ...args, signature: a.signature }, { ...args, agentId: "other" }, { ...args, principalId: "google:owner" },
      { ...args, signature: "0".repeat(128) }, { ...args, outcome: "succeeded" }])
      expect((await agent("inspect", invalid, mcp)).status).toBe(403);
    expect((await agent("inspect", args, mcp, {}, "tenant-b")).status).toBe(403);
    await revokePostgresDelegation(pgAccess(db()), pgAgentOrigin, a.delegationId);
    expect((await agent("inspect", args, mcp)).status).toBe(403); expect(resolve).not.toHaveBeenCalled();
  });
  it("rejects cookies, bearer identity, cross-origin calls and malformed bodies at the Agent boundary", async () => {
    const a = await approvePostgresAgentFixture(db()), args = { delegationId: a.delegationId, signature: a.signature };
    const refusedHeaders: Record<string, string>[] = [{ Cookie: "forged" }, { Authorization: "Bearer synthetic" }, { Origin: "https://other.test" }, { "Content-Type": "text/plain" }];
    for (const headers of refusedHeaders)
      expect((await agent("execute", args, false, headers)).status).toBe(403);
    expect((await agent("execute", { ...args, signature: "x".repeat(70000) })).status).toBe(413);
    expect(resolve).not.toHaveBeenCalled();
  });
  it("keeps resolver failures generic after verified execution authority", async () => {
    const a = await approvePostgresAgentFixture(db());
    const response = await agent("execute", { delegationId: a.delegationId, signature: a.signature });
    expect(response.status).toBe(403); expect(await response.text()).not.toContain("Synthetic resolver");
    expect(resolve).toHaveBeenCalledOnce();
  });
});
