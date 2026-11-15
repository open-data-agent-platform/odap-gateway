import { connect } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { startPostgresHttpHost, type PostgresHttpHostOptions } from "../integrations/postgresql/server";
import { openPostgresSqliteControl } from "../integrations/postgresql/sqlite-control";
import { SESSION_COOKIE, signAuthPayload } from "../lib/auth";
import { initializePostgresLocalFixture } from "./fixtures/postgresql-local-store";
import { seedPostgresControl, publishPostgresFixture, approvePostgresFixture } from "./fixtures/postgresql-control";
import { approvePostgresAgentFixture } from "./fixtures/postgresql-agent";
import { postgresBarrier } from "./fixtures/postgresql";
import { postgresHttpRequest } from "./fixtures/postgresql-http";

const origin = "https://gateway.test", secret = "synthetic-http-host-only";
type Host = Awaited<ReturnType<typeof startPostgresHttpHost>>;
let directory: string, store: ReturnType<typeof openPostgresSqliteControl>, cookie: string;
const hosts: Host[] = [];
const resolve = vi.fn(async () => { throw new Error("synthetic-private-resolver-error"); });
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "odap-pg-server-")); const file = join(directory, "ledger.db");
  initializePostgresLocalFixture(file); store = openPostgresSqliteControl(file);
  await seedPostgresControl(store.db); await publishPostgresFixture(store.db); await approvePostgresFixture(store.db);
  cookie = SESSION_COOKIE + "=" + await signAuthPayload({ provider: "google", providerId: "reader",
    email: "synthetic@example.test", name: "Synthetic", expiresAt: Date.now() + 600000 }, secret);
  resolve.mockClear();
});
afterEach(async () => {
  for (const host of hosts.splice(0)) expect(await host.close()).toEqual({ drained: true });
  store.close(); await rm(directory, { recursive: true, force: true });
});
async function start(overrides: Partial<PostgresHttpHostOptions> = {}) {
  const host = await startPostgresHttpHost({ origin, port: 0, env: { DB: store.db, AUTH_COOKIE_SECRET: secret }, resolve, ...overrides });
  hosts.push(host); return host;
}
function send(host: Host, command = "inspect", input: unknown = { requestId: "request" }, headers: Record<string, string> = {}, method = "POST") {
  return postgresHttpRequest(host.address, `/postgresql/tenant-a/${command}`, input,
    { Host: "gateway.test", Origin: origin, Cookie: cookie, ...headers }, method);
}
function raw(host: Host, text: string) {
  const address = new URL(host.address);
  return new Promise<string>((resolve, reject) => {
    const socket = connect(Number(address.port), "127.0.0.1", () => socket.write(text));
    let result = ""; socket.on("data", chunk => { result += chunk; }); socket.on("error", reject);
    socket.on("end", () => resolve(result)); socket.setTimeout(3000, () => { socket.destroy(); reject(new Error("Fixture socket timeout")); });
  });
}

it.each([false, true])("serves current session inspection without provider access (MCP=%s)", async mcp => {
  const host = await start(); expect(host.address).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  const reply = await send(host, mcp ? "mcp" : "inspect", mcp ? { jsonrpc: "2.0", id: "fixture", method: "tools/call",
    params: { name: "postgresql_inspect", arguments: { requestId: "request" } } } : { requestId: "request" }).result;
  expect(reply.status).toBe(200); expect(reply.cache).toBe("no-store");
  const data = JSON.parse(reply.data);
  expect(mcp ? JSON.parse(data.result.content[0].text) : data.result).toMatchObject({ used_attempts: 0, monetaryCost: "unpriced" });
  expect(resolve).not.toHaveBeenCalled();
});
it("accepts signed Agent inspection without borrowing browser identity", async () => {
  const a = await approvePostgresAgentFixture(store.db), host = await start();
  const data = JSON.stringify({ delegationId: a.delegationId, signature: a.inspectSignature });
  const reply = await raw(host, `POST /postgresql/tenant-a/agent-inspect HTTP/1.1\r\nHost: gateway.test\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(data)}\r\n\r\n${data}`);
  expect(reply).toContain("200 OK"); expect(reply).toContain('"monetaryCost":"unpriced"');
  expect(resolve).not.toHaveBeenCalled();
});
it.each(["Host", "Origin", "Cookie", "Authorization", "Content-Type"])("refuses ambiguous duplicate %s headers before authority resolution", async name => {
  const host = await start();
  const reply = await raw(host, `POST /postgresql/tenant-a/execute HTTP/1.1\r\nHost: gateway.test\r\n${name}: first\r\n${name}: second\r\nContent-Length: 2\r\n\r\n{}`);
  expect(reply).toContain("400 Bad Request"); expect(resolve).not.toHaveBeenCalled();
});
it.each<Record<string, string>>([{ Host: "attacker.test", "X-Forwarded-Host": "gateway.test" }, { Origin: "https://attacker.test" }, { Cookie: "", Authorization: "Bearer synthetic" }])(
  "does not accept spoofed origin, forwarded host or bearer session", async headers => {
    const reply = await send(await start(), "execute", { requestId: "request" }, headers).result;
    expect(reply.status).toBeGreaterThanOrEqual(400); expect(resolve).not.toHaveBeenCalled();
  });
it("preserves provider error privacy over the actual socket", async () => {
  const reply = await send(await start(), "execute").result;
  expect(reply.status).toBe(409); expect(reply.data).not.toContain("private-resolver");
  expect(await store.db.prepare("SELECT COUNT(*) AS n FROM postgresql_read_claims").first("n")).toBe(0);
});
it.each([false, true])("bounds request bodies before dispatch (chunked=%s)", async chunked => {
  const host = await start(), large = "x".repeat(65537);
  const reply = await raw(host, `POST /postgresql/tenant-a/execute HTTP/1.1\r\nHost: gateway.test\r\n${chunked ? "Transfer-Encoding: chunked" : "Content-Length: 65537"}\r\n\r\n${chunked ? "10001\r\n" + large + "\r\n0\r\n\r\n" : large}`);
  expect(reply).toContain("413 Payload Too Large"); expect(resolve).not.toHaveBeenCalled();
});
it("rejects encoded bodies, trailers, expectation handshakes and wrong methods", async () => {
  const host = await start();
  expect((await send(host, "execute", {}, { "Content-Encoding": "gzip" }).result).status).toBe(415);
  expect((await send(host, "execute", {}, {}, "GET").result).status).toBe(405);
  const prefix = "POST /postgresql/tenant-a/execute HTTP/1.1\r\nHost: gateway.test\r\n";
  expect(await raw(host, prefix + "Transfer-Encoding: chunked\r\n\r\n2\r\n{}\r\n0\r\nOrigin: https://attacker.test\r\n\r\n")).toContain("400 Bad Request");
  expect(await raw(host, prefix + "Expect: 100-continue\r\nContent-Length: 2\r\n\r\n")).toContain("417 Expectation Failed");
  expect(resolve).not.toHaveBeenCalled();
});
it("times out an incomplete body without dispatch", async () => {
  const reply = await raw(await start({ requestDeadlineMs: 100 }), "POST /postgresql/tenant-a/execute HTTP/1.1\r\nHost: gateway.test\r\nContent-Length: 20\r\n\r\n{");
  expect(reply).toContain("504 Gateway Timeout"); expect(resolve).not.toHaveBeenCalled();
});
it("does not append a parser-error response after an already sent response", async () => {
  const reply = await raw(await start(), "GET /postgresql/tenant-a/inspect HTTP/1.1\r\nHost: gateway.test\r\n\r\ninvalid-body");
  expect((reply.match(/HTTP\/1\.1 /g) ?? []).length).toBeLessThanOrEqual(1);
  expect(resolve).not.toHaveBeenCalled();
});
it("retains transport admission after deadline until the handler settles", async () => {
  const entered = postgresBarrier(), release = postgresBarrier();
  const host = await start({ maxRequests: 1, requestDeadlineMs: 100, resolve: async () => {
    entered.resolve(); await release.promise; throw new Error("synthetic");
  } });
  const first = send(host, "execute").result;
  try {
    await entered.promise; expect((await first).status).toBe(504);
    expect((await send(host).result).status).toBe(503);
    expect(await host.close(0)).toEqual({ drained: false });
  } finally { release.resolve(); await first; }
  expect(await host.close()).toEqual({ drained: true });
  expect(await store.db.prepare("SELECT COUNT(*) AS n FROM postgresql_read_claims").first("n")).toBe(0);
});
it("does not treat a disconnected client as completed host work", async () => {
  const entered = postgresBarrier(), release = postgresBarrier();
  const host = await start({ resolve: async () => { entered.resolve(); await release.promise; throw new Error("synthetic"); } });
  const first = send(host, "execute"), settled = first.result.then(() => "response", () => "disconnected");
  try {
    await entered.promise; first.destroy(); expect(await settled).toBe("disconnected");
    expect(await host.close(0)).toEqual({ drained: false });
  } finally { release.resolve(); }
  expect(await host.close()).toEqual({ drained: true });
});
it("drains admitted work and closes the listener idempotently", async () => {
  const entered = postgresBarrier(), release = postgresBarrier();
  const host = await start({ resolve: async () => { entered.resolve(); await release.promise; throw new Error("synthetic"); } });
  const first = send(host, "execute").result;
  await entered.promise; const closing = host.close(); release.resolve();
  expect((await first).status).toBe(409); expect(await closing).toEqual({ drained: true });
  expect(await host.close()).toEqual({ drained: true });
  await expect(send(host).result).rejects.toThrow();
});
it("refuses an occupied loopback port without stopping its owner", async () => {
  const host = await start();
  await expect(start({ port: Number(new URL(host.address).port) })).rejects.toThrow("listener unavailable");
  expect((await send(host).result).status).toBe(200);
});
it.each([{ origin: "http://gateway.test" }, { origin: "https://gateway.test/path" }, { port: -1 }, { port: 65536 },
  { maxRequests: 0 }, { maxRequests: 1025 }, { requestDeadlineMs: 99 }, { requestDeadlineMs: 120001 }])(
  "rejects invalid listener configuration %j", async options => { await expect(start(options)).rejects.toThrow(); });
