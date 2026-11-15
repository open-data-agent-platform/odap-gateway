import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_COOKIE, signAuthPayload } from "../lib/auth";
import { createPostgresGateway } from "../integrations/postgresql/gateway";
import { jobSqlite, jobTransactionalDatabase } from "./fixtures/job-sqlite";
import { pgAction, pgRun, publishPostgresFixture, seedPostgresControl } from "./fixtures/postgresql-control";

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
    expect(body.result.tools).toHaveLength(11);
    expect(body.result.tools.map((t: { name: string }) => t.name)).not.toContain("postgresql_observe");
    expect(body.result.tools.find((t: { name: string }) => t.name === "postgresql_execute").inputSchema)
      .toEqual({ type: "object", properties: { requestId: { type: "string" } }, required: ["requestId"], additionalProperties: false });
    expect(resolver).not.toHaveBeenCalled();
  });
});
