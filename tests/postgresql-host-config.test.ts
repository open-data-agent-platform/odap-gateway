import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it } from "vitest";
import { parsePostgresHostConfig, postgresHostConfigSummary, readPostgresHostFile } from "../integrations/postgresql/host-config";
import { configuredPostgresConnections } from "../integrations/postgresql/host";

let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "odap-pg-config-")); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
const fixture = () => ({ schemaVersion: 1, origin: "https://gateway.test", port: 54321,
  controlStorePath: join(directory, "not-created.db"), sessionSecretEnv: "ODAP_SESSION_SECRET", maxRequests: 16,
  maxConcurrentExecutions: 4, requestDeadlineMs: 10000, shutdownGraceMs: 2000,
  connections: [{ tenantId: "tenant-a", connectionRef: "pg-local", host: "database.example.test", port: 5432,
    database: "synthetic", role: "readonly", passwordEnv: "ODAP_DATABASE_PASSWORD", tls: {},
    statementTimeoutMs: 2000, lockTimeoutMs: 500, deadlineMs: 5000 }] });

it("validates a reference-only configuration without needing credentials, a ledger or a provider", () => {
  const result = parsePostgresHostConfig(JSON.stringify(fixture()));
  expect(postgresHostConfigSummary(result)).toMatchObject({ schemaVersion: 1, connections: 1,
    credentialsRead: false, providerContacted: false, controlStoreOpened: false });
  expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.connections)).toBe(true);
  expect(Object.isFrozen(result.connections[0])).toBe(true); expect(Object.isFrozen(result.connections[0].tls)).toBe(true);
  expect(JSON.stringify(postgresHostConfigSummary(result))).not.toContain("example.test");
});

it.each([
  ["schemaVersion", 2], ["origin", "http://gateway.test"], ["origin", "https://gateway.test/"],
  ["origin", "https://user:password@gateway.test"], ["port", 0], ["port", 65536], ["port", 1.5],
  ["controlStorePath", "relative.db"], ["controlStorePath", ""], ["sessionSecretEnv", "PGPASSWORD"],
  ["sessionSecretEnv", "secret-value"], ["maxRequests", 0], ["maxRequests", 1025],
  ["maxConcurrentExecutions", 17], ["maxConcurrentExecutions", 0], ["requestDeadlineMs", 99],
  ["requestDeadlineMs", 120001], ["shutdownGraceMs", -1], ["shutdownGraceMs", 120001],
  ["connections", []], ["connections", null], ["demo", true], ["adminEmail", "owner@example.test"],
])("refuses invalid/unknown host field %s=%j", (key, value) => {
  expect(() => parsePostgresHostConfig(JSON.stringify({ ...fixture(), [key as string]: value }))).toThrow("configuration unavailable");
});
it.each([
  ["tenantId", "tenant/other"], ["connectionRef", ""], ["host", "postgres://localhost"], ["port", 0],
  ["database", "bad;name"], ["role", "bad;role"], ["passwordEnv", "ODAP_SESSION_SECRET"],
  ["passwordEnv", "PGPASSWORD"], ["password", "synthetic-secret"], ["tls", { insecureLoopback: true }],
  ["tls", { rejectUnauthorized: false }], ["tls", { caFile: "relative.pem" }], ["tls", null],
  ["statementTimeoutMs", 30001], ["lockTimeoutMs", 2001], ["deadlineMs", 2000], ["deadlineMs", 10001],
  ["connectionString", "postgres://synthetic"], ["options", "-c search_path=public"],
])("refuses invalid/unknown connection field %s=%j", (key, value) => {
  const config = fixture(); Object.assign(config.connections[0], { [key as string]: value });
  expect(() => parsePostgresHostConfig(JSON.stringify(config))).toThrow("configuration unavailable");
});
it("rejects duplicate reference scopes but permits explicit isolation of the same reference across tenants", () => {
  const config = fixture(); config.connections.push({ ...config.connections[0] });
  expect(() => parsePostgresHostConfig(JSON.stringify(config))).toThrow();
  config.connections[1].tenantId = "tenant-b";
  expect(parsePostgresHostConfig(JSON.stringify(config)).connections).toHaveLength(2);
});
it.each(["duplicate", "escaped-duplicate", "comment", "trailing-comma", "extra-document", "oversized", "nested", "missing"])(
  "rejects ambiguous configuration input: %s", mode => {
    let text = JSON.stringify(fixture());
    if (mode === "duplicate") text = text.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1');
    if (mode === "escaped-duplicate") text = text.replace('"schemaVersion":1', '"schemaVersion":1,"schema\\u0056ersion":1');
    if (mode === "comment") text = "/* no comments */" + text;
    if (mode === "trailing-comma") text = text.slice(0, -1) + ",}";
    if (mode === "extra-document") text += "{}";
    if (mode === "oversized") text += " ".repeat(65536);
    if (mode === "nested") text = "[".repeat(20) + "0" + "]".repeat(20);
    if (mode === "missing") text = text.replace('"schemaVersion":1,', "");
    expect(() => parsePostgresHostConfig(text)).toThrow("configuration unavailable");
  });
it.each(["missing", "empty", "directory", "invalid-utf8", "oversized"])("refuses %s configuration files", async mode => {
  const path = join(directory, "config.json");
  if (mode === "directory") await mkdir(path);
  else if (mode !== "missing") await writeFile(path, mode === "invalid-utf8" ? Buffer.from([0xff]) : mode === "oversized" ? "x".repeat(65537) : "");
  expect(() => readPostgresHostFile(path)).toThrow("configuration unavailable");
});
it("reads bounded strict UTF-8 without creating the referenced control store", async () => {
  const file = join(directory, "config.json"), text = JSON.stringify(fixture()); await writeFile(file, text);
  expect(readPostgresHostFile(file)).toBe(text);
  expect(() => readPostgresHostFile(fixture().controlStorePath)).toThrow();
});
it("binds a fixed tenant/reference map and ignores ambient driver defaults", async () => {
  const config = parsePostgresHostConfig(JSON.stringify(fixture()));
  const env: Record<string, string | undefined> = { ODAP_DATABASE_PASSWORD: "synthetic-only" };
  Object.defineProperty(env, "PGPASSWORD", { get() { throw new Error("Ambient credentials must not be read"); } });
  const connections = await configuredPostgresConnections(config, env);
  expect(connections.bindings).toHaveLength(1);
  expect(connections.bindings[0].connectionDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  const resolved = await connections.resolve("tenant-a", "pg-local");
  expect(resolved.password).toBe("synthetic-only"); expect(resolved.tls).toEqual({});
  env.ODAP_DATABASE_PASSWORD = "changed-after-start";
  expect((await connections.resolve("tenant-a", "pg-local")).password).toBe("synthetic-only");
  await expect(connections.resolve("tenant-b", "pg-local")).rejects.toThrow("configuration unavailable");
  await expect(connections.resolve("tenant-a", "missing")).rejects.toThrow("configuration unavailable");
  expect(Object.isFrozen(resolved)).toBe(true); expect(Object.isFrozen(resolved.tls)).toBe(true);
  expect(JSON.stringify(connections.bindings)).not.toContain("synthetic-only");
});
it.each([undefined, "", "secret\0value", "x".repeat(8193)])("refuses missing or malformed explicit password reference %j", async password => {
  await expect(configuredPostgresConnections(parsePostgresHostConfig(JSON.stringify(fixture())),
    { ODAP_DATABASE_PASSWORD: password, PGPASSWORD: "not-a-fallback" })).rejects.toThrow("configuration unavailable");
});
it("rejects a CA file containing a private key without printing its contents", async () => {
  const config = fixture(), caFile = join(directory, "not-a-ca.pem");
  await writeFile(caFile, "-----BEGIN PRIVATE KEY-----\nsynthetic-not-a-key\n-----END PRIVATE KEY-----");
  config.connections[0].tls = { caFile };
  await expect(configuredPostgresConnections(parsePostgresHostConfig(JSON.stringify(config)),
    { ODAP_DATABASE_PASSWORD: "synthetic-only" })).rejects.toThrow("configuration unavailable");
});
