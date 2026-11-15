import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareIntentJob } from "../lib/bigquery-job-storage";
import { dispatchPreparedMetricRead } from "../lib/dispatch-authority";
import { handoffDelegatedRead } from "../lib/delegated-handoff";
import type { D1Database, D1Value } from "../lib/d1";
import { delegationFixture } from "./fixtures/delegation";
import { jobDatabase, jobSqlite } from "./fixtures/job-sqlite";
import metric from "./fixtures/revenue-metric.json";

type Fault = "before-commit-error" | "lost-commit-response" | "unconfirmed-commit" | "malformed-confirmation" | "revoke-before-claim";
const action = { target: "orders", metricId: "revenue", parameters: { year: 2026 } };

// The same durable-state assertions run against both existing dispatch paths.
// Each SQL operation uses a new SQLite connection, including replay attempts.
describe.each(["owner", "delegated"] as const)("%s read submission conformance", path => {
  let directory: string, baseline: string, file: string, keys: CryptoKeyPair;
  let intentId: string, principalId: string, receiptId: string;
  let subject: { principalId: string; agentId: string; audience: string };
  const db = jobDatabase(() => file);
  const fixture = delegationFixture(() => file, () => keys);
  const sql = (query: string, values: D1Value[] = []) => jobSqlite(file, "run", query, values);
  const first = (query: string, values: D1Value[] = []) => jobSqlite(file, "readonly-first", query, values);
  const ledger = () => first(`SELECT (SELECT count(*) FROM dispatch_claims) claims,
    (SELECT reserved_units FROM control_budgets WHERE tenant_id='t' AND id='b') reserved,
    (SELECT spent_units FROM control_budgets WHERE tenant_id='t' AND id='b') spent,
    (SELECT count(*) FROM cost_settlements) settlements,
    (SELECT count(*) FROM evidence_receipts) receipts`);

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "odap-read-conformance-"));
    file = baseline = join(directory, "baseline.db");
    if (path === "delegated") {
      keys = await fixture.keys();
      ({ intentId } = await fixture.seedAdmittedDelegation());
      principalId = "google:operator";
      subject = { principalId: "google:reader", agentId: "reporter", audience: "test-gateway" };
      await jobSqlite(file, "apply-delegated-jobs");
      const response = await fixture.post("t/job-preparations", { intentId }, "operator");
      expect(response.status).toBe(201);
      receiptId = ((await response.json()) as { preparation: { receiptId: string } }).preparation.receiptId;
      await jobSqlite(file, "apply-delegated-handoff");
    } else {
      await jobSqlite(file, "setup");
      intentId = "i"; principalId = "owner";
      subject = { principalId: "user", agentId: "agent", audience: "unused" };
      const prepared = await prepareIntentJob({ db, tenantId: "t", principalId }, intentId,
        { BIGQUERY_PROJECT_ID: "demo-project", BIGQUERY_LOCATION: "US" });
      receiptId = prepared.receipt.id;
      await sql("INSERT INTO dispatch_targets VALUES('t','orders','r','p1','s1','demo-project','US')");
      await sql("INSERT INTO dispatch_read_grants VALUES('t','orders','user','agent','p1')");
      await sql(`INSERT INTO bigquery_scan_policies VALUES
        ('t','orders','p1','demo-project','US','on_demand',262144,100000000,'2080-01-01T00:00:00.000Z','synthetic')`);
    }
    expect((await ledger()).reserved).toBeGreaterThan(0);
    expect(await first("SELECT json_extract(payload,'$.outcome') outcome FROM evidence_receipts WHERE id=?", [receiptId]))
      .toEqual({ outcome: "pending" });
  }, 60_000);
  beforeEach(async () => {
    file = join(directory, crypto.randomUUID() + ".db");
    await copyFile(baseline, file);
  });
  afterAll(async () => {
    if (directory && resolve(directory).startsWith(resolve(tmpdir()) + sep))
      await rm(directory, { recursive: true, force: true });
  });

  const run = (send: () => Promise<void>, database = db, tenantId = "t", actor = subject, read = action) => {
    const access = { db: database, tenantId, principalId };
    if (path === "delegated") return handoffDelegatedRead(access, intentId, actor, read, send);
    return dispatchPreparedMetricRead(access, intentId, actor, read, {
      projectId: "demo-project", location: "US", maxBytesBilled: 1048576,
      loadDefinition: async () => JSON.stringify(metric), prepareRead: async () => send,
    });
  };

  function inject(fault: Fault) {
    let writes = 0;
    const database: D1Database = { prepare(query) {
      const base = db.prepare(query);
      if (!query.startsWith("INSERT INTO dispatch_claims")) return base;
      return { ...base, bind(...args) {
        const statement = base.bind(...args);
        const intercept = async (write: () => Promise<unknown>) => {
          writes++;
          if (fault === "before-commit-error") throw new Error("synthetic pre-commit failure");
          if (fault === "revoke-before-claim") await sql("DELETE FROM dispatch_read_grants");
          const result = await write();
          if (fault === "lost-commit-response") throw new Error("synthetic commit response lost");
          if (fault === "malformed-confirmation") return { success: 1, meta: { changes: 1 }, digest: true };
          return fault === "unconfirmed-commit" ? null : result;
        };
        return { ...statement,
          first: async <T>() => await intercept(() => statement.first<T>()) as T | null,
          run: async <T>() => (await intercept(() => statement.run<T>()) ?? { success: false }) as Awaited<ReturnType<typeof statement.run<T>>>,
        };
      } };
    } };
    return { database, writes: () => writes };
  }

  it("has exactly one successful sender across concurrent requests, never zero", async () => {
    const before = await ledger();
    const send = vi.fn(async () => {
      expect(await ledger()).toEqual({ ...before, claims: 1 });
      expect((await first("SELECT maximum_bytes_billed cap FROM dispatch_claims")).cap).toBeGreaterThan(0);
    });
    const results = await Promise.allSettled([run(send), run(send), run(send)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
    await expect(run(send, jobDatabase(() => file))).rejects.toThrow();
    expect(send).toHaveBeenCalledTimes(1);
    expect(await ledger()).toEqual({ ...before, claims: 1 });
  }, 30_000);

  it.each(["before-commit-error", "lost-commit-response", "unconfirmed-commit", "malformed-confirmation", "revoke-before-claim"] as const)(
    "preserves the ledger and refuses to send after %s", async fault => {
      const before = await ledger(), hook = inject(fault), send = vi.fn(async () => undefined);
      await expect(run(send, hook.database)).rejects.toThrow();
      expect(hook.writes()).toBe(1);
      expect(send).not.toHaveBeenCalled();
      const claimed = ["lost-commit-response", "unconfirmed-commit", "malformed-confirmation"].includes(fault);
      expect(await ledger()).toEqual({ ...before, claims: Number(claimed) });
      if (fault === "before-commit-error") {
        await run(send, jobDatabase(() => file));
        expect(send).toHaveBeenCalledTimes(1);
      } else {
        await expect(run(send, jobDatabase(() => file))).rejects.toThrow();
        expect(send).not.toHaveBeenCalled();
      }
    }, 30_000);

  it("keeps reservation and pending evidence after a sender failure and reconnect", async () => {
    const before = await ledger();
    const send = vi.fn(async () => { throw new Error("synthetic acknowledgment loss"); });
    if (path === "delegated") expect(await run(send)).toMatchObject({ state: "observation-required" });
    else await expect(run(send)).rejects.toThrow("acknowledgment loss");
    await expect(run(send, jobDatabase(() => file))).rejects.toThrow();
    expect(send).toHaveBeenCalledTimes(1);
    expect(await ledger()).toEqual({ ...before, claims: 1 });
    expect(await first("SELECT json_extract(payload,'$.outcome') outcome FROM evidence_receipts WHERE id=?", [receiptId]))
      .toEqual({ outcome: "pending" });
  }, 30_000);

  it("preserves tenant, principal, agent and action binding on both paths", async () => {
    const before = await ledger(), send = vi.fn(async () => undefined);
    await expect(run(send, db, "other")).rejects.toThrow();
    await expect(run(send, db, "t", { ...subject, principalId: "other" })).rejects.toThrow();
    await expect(run(send, db, "t", { ...subject, agentId: "other" })).rejects.toThrow();
    await expect(run(send, db, "t", subject, { ...action, parameters: { year: 2025 } })).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
    expect(await ledger()).toEqual(before);
  }, 30_000);
});
