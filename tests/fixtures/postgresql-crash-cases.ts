import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { beforeAll, afterAll, expect, it } from "vitest";
import type { Client } from "pg";
import type { D1Database } from "../../lib/d1";
import type { PostgresHostConfig } from "../../integrations/postgresql";
import { postgresDefinition } from "./postgresql";
import { approvePostgresAgentFixture } from "./postgresql-agent";
import type { PostgresCrashInput } from "./postgresql-crash-host";

type Fixture = (test: (db: D1Database, file: string) => Promise<void>, config: PostgresHostConfig, definition: typeof postgresDefinition) => Promise<void>;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export function postgresCrashCases(fixture: Fixture, admin: Client, config: PostgresHostConfig) {
  let directory: string, entry: string;
  beforeAll(async () => {
    await mkdir(".tmp", { recursive: true }); directory = await mkdtemp(resolve(".tmp/postgresql-crash-"));
    entry = join(directory, "host.cjs");
    await build({ entryPoints: ["tests/fixtures/postgresql-crash-host.ts"], outfile: entry, bundle: true,
      platform: "node", format: "cjs", target: "node24", external: ["pg"], logLevel: "silent" });
  });
  afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });
  function start(input: PostgresCrashInput) {
    const child = spawn(process.execPath, [entry], { stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true });
    const messages: Record<string, unknown>[] = [];
    let error: Error | undefined, exited = false;
    child.on("message", value => messages.push(value as Record<string, unknown>));
    child.on("error", value => { error = value; });
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once("close", (code, signal) => {
      exited = true; resolve({ code, signal });
    }));
    child.send(input);
    return { child, closed, messages, async wait(predicate: (m: Record<string, unknown>) => boolean) {
      for (const end = Date.now() + 15000; Date.now() < end;) {
        if (error) throw error;
        if (messages.some(m => m.fixtureError || m.unexpectedCompletion)) throw new Error("Crash checkpoint was not reached");
        const message = messages.find(predicate); if (message) return message;
        if (exited) throw new Error("Crash fixture exited before required checkpoint");
        await delay(10);
      }
      throw new Error("Crash checkpoint deadline exceeded");
    }, async stop() {
      if (!exited) child.kill("SIGKILL");
      return closed;
    } };
  }
  for (const agent of [false, true]) it.each(["claim-ack", "query-running", "observation-ack", "terminal-ack"] as const)(
    `recovers durable state after actual host SIGKILL at %s (Agent=${agent})`, async phase => {
      const c = phase === "terminal-ack" ? { ...config, statementTimeoutMs: 100, lockTimeoutMs: 50 } :
        { ...config, statementTimeoutMs: 3000, deadlineMs: 6000 };
      const definition = phase === "query-running" || phase === "terminal-ack" ?
        { ...postgresDefinition, table: { ...postgresDefinition.table, name: "crash_orders" } } : postgresDefinition;
      await fixture(async (db, file) => {
        const a = agent ? await approvePostgresAgentFixture(db) : undefined;
        const input: PostgresCrashInput = { file, config: c, phase, mode: "execute", agent: a && {
          delegationId: a.delegationId, signature: a.signature, inspectSignature: a.inspectSignature } };
        const executing = start(input);
        try {
          if (phase === "query-running") {
            await expect.poll(async () => {
              if (executing.messages.length) throw new Error("Query exited before forced termination");
              return (await admin.query(`SELECT pid FROM pg_stat_activity WHERE datname='odap_pg_fixture'
                AND usename='reader_a' AND application_name='odap-postgresql-preview' AND state='active'
                AND wait_event='PgSleep' AND query LIKE '%AS metric_value FROM ONLY%crash_orders%'`)).rows.length;
            }, { timeout: 12000, interval: 10 }).toBe(1);
          } else await executing.wait(m => m.checkpoint === phase);
          expect(await executing.stop()).toEqual({ code: null, signal: "SIGKILL" });
          const recovering = start({ ...input, mode: "recover" });
          try {
            const result = await recovering.wait(m => m.recovered === true);
            const state = phase === "observation-ack" ? "succeeded" : phase === "terminal-ack" ? "failed" : "observation-required";
            expect(result).toMatchObject({ refused: true, resolverCalls: 0, inspected: { state, used_attempts: 1, monetaryCost: "unpriced" } });
            if (agent) expect(result.agentInspection).toMatchObject({ state });
            expect(result.inspected).not.toHaveProperty("value");
            expect(result.inspected).toMatchObject({ unresolved_claims: state === "observation-required" ? 1 : 0,
              resourceUnit: "unresolved-read-claim" });
            expect(await recovering.closed).toEqual({ code: 0, signal: null });
          } finally { await recovering.stop(); }
          expect(await db.prepare("SELECT count(*) AS n FROM postgresql_read_claims").bind().first()).toEqual({ n: 1 });
          expect(await db.prepare("SELECT count(*) AS n FROM evidence_receipts WHERE tenant_id='tenant-a'").bind().first())
            .toEqual({ n: phase === "observation-ack" || phase === "terminal-ack" ? 2 : 1 });
          // Cleanup observation is only fixture hygiene, never a cancellation/success proof.
          await expect.poll(async () => (await admin.query("SELECT pid FROM pg_stat_activity WHERE application_name='odap-postgresql-preview'")).rows.length,
            { timeout: 7000, interval: 50 }).toBe(0);
        } finally { await executing.stop(); }
      }, c, definition);
    }, 30000);
}
