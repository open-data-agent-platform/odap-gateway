import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION_META_KEY, CLIENT_INFO_META_KEY, CLIENT_CAPABILITIES_META_KEY } from "@modelcontextprotocol/client";
import { startPostgresHttpHost } from "../integrations/postgresql/server";
import { openPostgresSqliteControl } from "../integrations/postgresql/sqlite-control";
import { SESSION_COOKIE, signAuthPayload } from "../lib/auth";
import { initializePostgresLocalFixture } from "./fixtures/postgresql-local-store";
import { seedPostgresControl, publishPostgresFixture, approvePostgresFixture } from "./fixtures/postgresql-control";
import { approvePostgresAgentFixture } from "./fixtures/postgresql-agent";
import { connectPostgresMcpFixture } from "./fixtures/postgresql-mcp";
import { postgresHttpRequest } from "./fixtures/postgresql-http";
import { postgresBarrier } from "./fixtures/postgresql";
import { revokePostgresDelegation } from "../lib/postgresql-agent";
import { pgAccess } from "./fixtures/postgresql-control";
import { claimPostgresRead, preparePostgresDispatch } from "../lib/postgresql-control";
import { verifyPostgresEvidence } from "../lib/postgresql-evidence";

const origin = "https://gateway.test", secret = "synthetic-mcp-host-only";
let directory: string, store: ReturnType<typeof openPostgresSqliteControl>, cookie: string;
let host: Awaited<ReturnType<typeof startPostgresHttpHost>>;
const clients: Awaited<ReturnType<typeof connectPostgresMcpFixture>>[] = [];
const resolve = vi.fn(async () => { throw new Error("synthetic-private-provider-error"); });
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "odap-pg-mcp-")); const file = join(directory, "ledger.db");
  initializePostgresLocalFixture(file); store = openPostgresSqliteControl(file);
  await seedPostgresControl(store.db); await publishPostgresFixture(store.db); await approvePostgresFixture(store.db);
  cookie = SESSION_COOKIE + "=" + await signAuthPayload({ provider: "google", providerId: "reader",
    email: "synthetic@example.test", name: "Synthetic", expiresAt: Date.now() + 600000 }, secret);
  resolve.mockReset(); resolve.mockImplementation(async () => { throw new Error("synthetic-private-provider-error"); });
  host = await startPostgresHttpHost({ origin, port: 0, env: { DB: store.db, AUTH_COOKIE_SECRET: secret }, resolve });
});
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  expect(await host.close()).toEqual({ drained: true }); store.close();
  await rm(directory, { recursive: true, force: true });
});
async function client(agent = false, modern = false, tenant = "tenant-a", headers?: Record<string, string>) {
  const connected = await connectPostgresMcpFixture(host.address, origin,
    `/postgresql/${tenant}/${agent ? "agent-mcp-stream" : "mcp-stream"}`,
    headers ?? (agent ? {} : { Origin: origin, Cookie: cookie }), modern);
  clients.push(connected); return connected;
}
function text(result: { content?: unknown }) {
  return (result.content as { type: string; text: string }[])[0].text;
}
it.each([false, true])("exports a current-owner snapshot through the official MCP client (modern=%s)", async modern => {
  const access = pgAccess(store.db), { row } = await preparePostgresDispatch(access, "request");
  await claimPostgresRead(access, row, "intent");
  const reader = await client(false, modern);
  expect((await reader.client.callTool({ name: "postgresql_export_evidence", arguments: { requestId: "request" } })).isError).toBe(true);
  const ownerCookie = SESSION_COOKIE + "=" + await signAuthPayload({ provider: "google", providerId: "owner",
    email: "synthetic@example.test", name: "Synthetic", expiresAt: Date.now() + 600000 }, secret);
  const owner = await client(false, modern, "tenant-a", { Origin: origin, Cookie: ownerCookie });
  const result = await owner.client.callTool({ name: "postgresql_export_evidence", arguments: { requestId: "request" } });
  expect(result.isError).toBe(false); const bundle = JSON.parse(text(result));
  expect(await verifyPostgresEvidence(bundle.json, { tenantId: "tenant-a", requestId: "request", intentId: "intent" }, bundle.digest))
    .toMatchObject({ consistent: true, state: "observation-required", providerVerified: false });
  expect(resolve).not.toHaveBeenCalled();
});
it.each([false, true])("initializes the official session client and shares current control authority (modern=%s)", async modern => {
  const connection = await client(false, modern);
  expect(connection.methods).toContain(modern ? "server/discover" : "initialize");
  const tools = await connection.client.listTools();
  expect(tools.tools.some(t => t.name === "postgresql_cancel")).toBe(true);
  expect(tools.tools.some(t => t.name === "postgresql_agent_execute")).toBe(false);
  const result = await connection.client.callTool({ name: "postgresql_inspect", arguments: { requestId: "request" } });
  expect(result.isError).toBe(false); expect(JSON.parse(text(result))).toMatchObject({ used_attempts: 0, monetaryCost: "unpriced" });
  expect(resolve).not.toHaveBeenCalled();
});
it.each([false, true])("offers only static Agent discovery and requires a scoped proof per operation (modern=%s)", async modern => {
  const a = await approvePostgresAgentFixture(store.db), connection = await client(true, modern);
  const tools = await connection.client.listTools();
  expect(tools.tools.map(t => t.name)).toEqual(["postgresql_agent_execute", "postgresql_agent_inspect"]);
  const valid = await connection.client.callTool({ name: "postgresql_agent_inspect",
    arguments: { delegationId: a.delegationId, signature: a.inspectSignature } });
  expect(valid.isError).toBe(false); expect(JSON.parse(text(valid))).toMatchObject({ state: "not-submitted", unresolvedClaims: 0 });
  const refused = await connection.client.callTool({ name: "postgresql_agent_execute", arguments: {} });
  expect(refused.isError).toBe(true); expect(resolve).not.toHaveBeenCalled();
});
it("revalidates human membership after initialization before listing or calling", async () => {
  const c = (await client()).client;
  await store.db.prepare("UPDATE control_memberships SET active=0 WHERE tenant_id='tenant-a' AND principal_id='google:reader'").run();
  await expect(c.listTools()).rejects.toThrow();
  await expect(c.callTool({ name: "postgresql_execute", arguments: { requestId: "request" } })).rejects.toThrow();
  expect(resolve).not.toHaveBeenCalled();
});
it("does not reuse an initialized identity on a different tenant or borrow a browser session for Agent calls", async () => {
  await client(); await expect(client(false, false, "tenant-c")).rejects.toThrow();
  const other = (await client(false, false, "tenant-b")).client;
  expect((await other.callTool({ name: "postgresql_inspect", arguments: { requestId: "request" } })).isError).toBe(true);
  await expect(client(true, false, "tenant-a", { Cookie: cookie })).rejects.toThrow();
  const a = await approvePostgresAgentFixture(store.db), c = (await client(true, false, "tenant-b")).client;
  expect((await c.callTool({ name: "postgresql_agent_inspect", arguments: { delegationId: a.delegationId, signature: a.inspectSignature } })).isError).toBe(true);
  expect(resolve).not.toHaveBeenCalled();
});
it.each<Record<string, string>>([{}, { Origin: "https://attacker.test" }, { Authorization: "Bearer synthetic" }])(
  "refuses unauthenticated or cross-origin session initialization %j", async headers => {
    await expect(client(false, false, "tenant-a", headers)).rejects.toThrow(); expect(resolve).not.toHaveBeenCalled();
  });
it("keeps schema validation and provider errors behind the existing command boundary", async () => {
  const c = (await client()).client;
  expect((await c.callTool({ name: "postgresql_execute", arguments: { requestId: "request", sql: "synthetic-secret" } })).isError).toBe(true);
  expect(resolve).not.toHaveBeenCalled();
  const refused = await c.callTool({ name: "postgresql_execute", arguments: { requestId: "request" } });
  expect(refused.isError).toBe(true); expect(text(refused)).not.toContain("private-provider");
  expect(await store.db.prepare("SELECT COUNT(*) AS n FROM postgresql_read_claims").first("n")).toBe(0);
});
it("does not confuse protocol sessions with authentication or expose persistent transport sessions", async () => {
  const reply = await postgresHttpRequest(host.address, "/postgresql/tenant-a/mcp-stream", { jsonrpc: "2.0", id: 1, method: "ping" },
    { Host: "gateway.test", Origin: origin, Cookie: cookie, "Mcp-Session-Id": "synthetic" }).result;
  expect(reply.status).toBe(400); expect(reply.cache).toBe("no-store"); expect(resolve).not.toHaveBeenCalled();
});
it("waits for admitted MCP work after SDK client disconnect before reporting a drained host", async () => {
  const entered = postgresBarrier(), release = postgresBarrier();
  resolve.mockImplementation(async () => { entered.resolve(); await release.promise; throw new Error("synthetic"); });
  const c = await client(); const call = c.client.callTool({ name: "postgresql_execute", arguments: { requestId: "request" } }).catch(() => null);
  try {
    await entered.promise; await c.close(); expect(await host.close(0)).toEqual({ drained: false });
  } finally { release.resolve(); await call; }
  expect(await host.close()).toEqual({ drained: true });
  expect(await store.db.prepare("SELECT COUNT(*) AS n FROM postgresql_read_claims").first("n")).toBe(0);
});

it("rechecks signed Agent consent after standard protocol initialization", async () => {
  const a = await approvePostgresAgentFixture(store.db), c = (await client(true, true)).client;
  await revokePostgresDelegation(pgAccess(store.db), origin, a.delegationId);
  const result = await c.callTool({ name: "postgresql_agent_inspect", arguments: { delegationId: a.delegationId, signature: a.inspectSignature } });
  expect(result.isError).toBe(true); expect(resolve).not.toHaveBeenCalled();
});
it.each(["mcp-method", "mcp-name"])("rejects modern %s/body disagreement before dispatch", async header => {
  const input = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "postgresql_execute",
    arguments: { requestId: "request" }, _meta: { [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
      [CLIENT_INFO_META_KEY]: { name: "fixture", version: "0.1.0" }, [CLIENT_CAPABILITIES_META_KEY]: {} } } };
  const reply = await postgresHttpRequest(host.address, "/postgresql/tenant-a/mcp-stream", input,
    { Host: "gateway.test", Origin: origin, Cookie: cookie, Accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": "postgresql_execute", [header]: "mismatched" }).result;
  expect(reply.status).toBe(400); expect(reply.cache).toBe("no-store"); expect(resolve).not.toHaveBeenCalled();
  expect(JSON.parse(reply.data).error.code).toBe(-32020);
  expect(JSON.parse(reply.data).error.message).toContain("mismatched");
});
it.each([[], "invalid-message", { jsonrpc: "2.0", id: 1, method: 42 }])("rejects invalid protocol messages without claiming %j", async input => {
  const reply = await postgresHttpRequest(host.address, "/postgresql/tenant-a/mcp-stream", input,
    { Host: "gateway.test", Origin: origin, Cookie: cookie, Accept: "application/json, text/event-stream" }).result;
  expect(reply.status).toBe(400); expect(resolve).not.toHaveBeenCalled();
});
it("does not treat protocol cancellation notifications as durable cancellation authority", async () => {
  const reply = await postgresHttpRequest(host.address, "/postgresql/tenant-a/mcp-stream",
    { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } },
    { Host: "gateway.test", Origin: origin, Cookie: cookie, Accept: "application/json, text/event-stream" }).result;
  expect(reply.status).toBe(202);
  expect(await store.db.prepare("SELECT COUNT(*) AS n FROM postgresql_cancellation_requests").first("n")).toBe(0);
  expect(resolve).not.toHaveBeenCalled();
});
it("shares execution admission with REST while retaining standard MCP inspection", async () => {
  await host.close();
  host = await startPostgresHttpHost({ origin, port: 0, env: { DB: store.db, AUTH_COOKIE_SECRET: secret }, resolve, maxConcurrentExecutions: 1 });
  const entered = postgresBarrier(), release = postgresBarrier(), c = (await client(false, true)).client;
  resolve.mockImplementation(async () => { entered.resolve(); await release.promise; throw new Error("synthetic"); });
  const pending = postgresHttpRequest(host.address, "/postgresql/tenant-a/execute", { requestId: "request" },
    { Host: "gateway.test", Origin: origin, Cookie: cookie }).result;
  try {
    await entered.promise;
    expect((await c.callTool({ name: "postgresql_execute", arguments: { requestId: "request" } })).isError).toBe(true);
    expect((await c.callTool({ name: "postgresql_inspect", arguments: { requestId: "request" } })).isError).toBe(false);
    expect(resolve).toHaveBeenCalledTimes(1);
  } finally { release.resolve(); await pending; }
});
