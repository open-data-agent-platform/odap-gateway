import { createServer } from "node:net";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { startConfiguredPostgresHost } from "../integrations/postgresql/host";
import { openPostgresSqliteControl } from "../integrations/postgresql/sqlite-control";
import { initializePostgresLocalFixture } from "./fixtures/postgresql-local-store";
import { seedPostgresControl, publishPostgresFixture, approvePostgresFixture } from "./fixtures/postgresql-control";
import { SESSION_COOKIE, signAuthPayload } from "../lib/auth";
import { postgresHttpRequest } from "./fixtures/postgresql-http";

const secret = "synthetic-configured-host-session-secret";
const hosts: Awaited<ReturnType<typeof startConfiguredPostgresHost>>[] = [];
let directory: string, file: string, ledger: string, config: Record<string, unknown>;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "odap-pg-configured-")); file = join(directory, "config.json"); ledger = join(directory, "ledger.db");
  const socket = createServer(); await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
  const address = socket.address(); if (!address || typeof address === "string") throw new Error("fixture port unavailable");
  await new Promise<void>((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
  config = { schemaVersion: 1, origin: "https://gateway.test", port: address.port, controlStorePath: ledger,
    sessionSecretEnv: "ODAP_SESSION_SECRET", maxRequests: 8, maxConcurrentExecutions: 2, requestDeadlineMs: 10000,
    shutdownGraceMs: 1000, connections: [{ tenantId: "tenant-a", connectionRef: "synthetic", host: "never-contact.invalid",
      port: 5432, database: "synthetic", role: "readonly", passwordEnv: "ODAP_DATABASE_PASSWORD", tls: {},
      statementTimeoutMs: 2000, lockTimeoutMs: 500, deadlineMs: 5000 }] };
  await writeFile(file, JSON.stringify(config));
});
afterEach(async () => {
  for (const host of hosts.splice(0)) expect(await host.close()).toEqual({ drained: true });
  await rm(directory, { recursive: true, force: true });
});
const environment = () => ({ ODAP_SESSION_SECRET: secret, ODAP_DATABASE_PASSWORD: "synthetic-unused-password" });
async function start() { const host = await startConfiguredPostgresHost(file, environment()); hosts.push(host); return host; }

it("never creates a missing ledger while starting a configured host", async () => {
  await expect(start()).rejects.toThrow("control store operation unavailable");
  await expect(readFile(ledger)).rejects.toMatchObject({ code: "ENOENT" });
});
it("does not upgrade or overwrite an unsupported existing ledger", async () => {
  const contents = Buffer.from("synthetic-invalid-database"); await writeFile(ledger, contents);
  await expect(start()).rejects.toThrow("control store operation unavailable");
  expect(await readFile(ledger)).toEqual(contents);
});
it.each([undefined, "", "too-short"])("refuses absent or weak session configuration before opening storage", async value => {
  await expect(startConfiguredPostgresHost(file, { ...environment(), ODAP_SESSION_SECRET: value })).rejects.toThrow("configuration unavailable");
  await expect(readFile(ledger)).rejects.toMatchObject({ code: "ENOENT" });
});
it("serves authenticated inspection using only the existing synthetic ledger and drains idempotently", async () => {
  initializePostgresLocalFixture(ledger); const store = openPostgresSqliteControl(ledger);
  try { await seedPostgresControl(store.db); await publishPostgresFixture(store.db); await approvePostgresFixture(store.db); }
  finally { store.close(); }
  const host = await start();
  const cookie = SESSION_COOKIE + "=" + await signAuthPayload({ provider: "google", providerId: "reader", email: "synthetic@example.test",
    name: "Synthetic", expiresAt: Date.now() + 600000 }, secret);
  const request = (headers: Record<string, string>) => postgresHttpRequest(host.address, "/postgresql/tenant-a/inspect",
    { requestId: "request" }, { Host: "gateway.test", Origin: "https://gateway.test", ...headers }).result;
  expect((await request({})).status).toBe(401);
  const response = await request({ Cookie: cookie }); expect(response.status).toBe(200);
  expect(JSON.parse(response.data).result).toMatchObject({ used_attempts: 0, monetaryCost: "unpriced" });
  expect(await host.close()).toEqual({ drained: true }); expect(await host.close()).toEqual({ drained: true });
});
it("closes its control binding after a listener bind failure without changing the ledger schema", async () => {
  initializePostgresLocalFixture(ledger);
  const first = await start(); await expect(start()).rejects.toThrow("configured host unavailable");
  expect(await first.close()).toEqual({ drained: true });
  const next = await start(); expect(next.address).toBe(first.address);
});
