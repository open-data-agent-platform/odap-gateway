import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { beforeAll, afterAll, expect, it } from "vitest";
import { initializePostgresLocalFixture } from "./fixtures/postgresql-local-store";
import { postgresHttpRequest } from "./fixtures/postgresql-http";

const run = promisify(execFile);
let directory: string, entry: string, file: string;
let config: Record<string, unknown>;
const children = new Set<ChildProcess>();
const env = () => ({ NODE_ENV: "test" as const, PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP,
  TMP: process.env.TMP, ODAP_SESSION_SECRET: "synthetic-cli-session-secret-over-32-bytes", ODAP_DATABASE_PASSWORD: "synthetic-cli-password" });
beforeAll(async () => {
  await mkdir(resolve(".tmp"), { recursive: true }); directory = await mkdtemp(resolve(".tmp/postgresql-cli-"));
  const output = join(directory, "compiled");
  await run(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "scripts/tsconfig.postgresql.json", "--outDir", output],
    { windowsHide: true, timeout: 60000, maxBuffer: 1024 * 1024 });
  entry = join(output, "integrations/postgresql/cli.js"); file = join(directory, "config.json");
  config = { schemaVersion: 1, origin: "https://gateway.test", port: 54321, controlStorePath: join(directory, "not-created.db"),
    sessionSecretEnv: "ODAP_SESSION_SECRET", maxRequests: 8, maxConcurrentExecutions: 2, requestDeadlineMs: 10000,
    shutdownGraceMs: 1000, connections: [{ tenantId: "tenant-a", connectionRef: "synthetic", host: "never-contact.invalid", port: 5432,
      database: "synthetic", role: "readonly", passwordEnv: "ODAP_DATABASE_PASSWORD", tls: {}, statementTimeoutMs: 2000,
      lockTimeoutMs: 500, deadlineMs: 5000 }] };
  await writeFile(file, JSON.stringify(config));
}, 90000);
afterAll(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL"); await new Promise<void>(resolve => child.once("close", () => resolve()));
    }
  }
  await rm(directory, { recursive: true, force: true });
});
it("checks a compiled host without reading environment credentials or opening a missing ledger", async () => {
  const result = await run(process.execPath, [entry, "check", "--config", file], { windowsHide: true, timeout: 10000, env: { NODE_ENV: "test" } });
  expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, connections: 1, credentialsRead: false,
    providerContacted: false, controlStoreOpened: false });
  expect(result.stderr).toBe(""); await expect(readFile(config.controlStorePath as string)).rejects.toMatchObject({ code: "ENOENT" });
});
it.each(["missing", "unknown-command", "duplicate-option", "extra-option", "relative-path"])("refuses %s CLI usage with sanitized failure", async mode => {
  const args = mode === "missing" ? ["check"] : mode === "unknown-command" ? ["migrate", "--config", file] :
    mode === "duplicate-option" ? ["check", "--config", file, "--config", file] :
    mode === "extra-option" ? ["check", "--config", file, "--demo"] : ["check", "--config", "relative.json"];
  try {
    await run(process.execPath, [entry, ...args], { windowsHide: true, timeout: 10000, env: env() });
    throw new Error("CLI unexpectedly accepted invalid usage");
  } catch (error) {
    expect(error).toMatchObject({ code: 1, stdout: "" });
    const stderr = (error as { stderr: string }).stderr;
    expect(stderr).toBe("PostgreSQL host unavailable; verify the explicit configuration and runtime\n");
    expect(stderr).not.toContain(directory); expect(stderr).not.toContain("synthetic-cli-password");
  }
});
it("refuses to initialize a missing control store during serve", async () => {
  await expect(run(process.execPath, [entry, "serve", "--config", file], { windowsHide: true, timeout: 10000, env: env() }))
    .rejects.toMatchObject({ code: 1, stdout: "" });
  await expect(readFile(config.controlStorePath as string)).rejects.toMatchObject({ code: "ENOENT" });
});

// Windows terminate signals cannot exercise a cooperative Node SIGTERM handler.
// The same assertion is mandatory in the Linux CI process test, never counted as
// successful signal handling on Windows.
if (process.platform !== "win32") it("starts the compiled host and exits normally after cooperative SIGTERM drain", async () => {
  const listener = createServer(); await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address(); if (!address || typeof address === "string") throw new Error("Fixture port unavailable");
  await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  const ledger = join(directory, "synthetic-ledger.db"), live = join(directory, "live.json");
  initializePostgresLocalFixture(ledger); await writeFile(live, JSON.stringify({ ...config, port: address.port, controlStorePath: ledger }));
  const child = spawn(process.execPath, [entry, "serve", "--config", live], { env: env(), windowsHide: true }); children.add(child);
  let stdout = "", stderr = ""; child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const deadline = Date.now() + 10000;
  while (!stdout.includes('"event":"ready"') && child.exitCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  expect(stdout).toContain('"event":"ready"');
  const reply = await postgresHttpRequest(`http://127.0.0.1:${address.port}`, "/postgresql/tenant-a/inspect", { requestId: "request" },
    { Host: "gateway.test", Origin: "https://gateway.test" }).result;
  expect(reply.status).toBe(401); child.kill("SIGTERM");
  expect(await exit).toEqual({ code: 0, signal: null }); expect(stdout).toContain('"event":"stopped","drained":true');
  expect(stdout + stderr).not.toContain("synthetic-cli-password"); expect(stdout + stderr).not.toContain("never-contact.invalid");
}, 20000);
