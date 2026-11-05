import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ControlAccess } from "../lib/control-storage";
import type { D1Database, D1Value } from "../lib/d1";
import { prepareIntentJob } from "../lib/bigquery-job-storage";
import { stopBeforeDispatch } from "../lib/pre-dispatch-stop";
import { jobSqlite } from "./fixtures/job-sqlite";

let dir: string, access: ControlAccess;
const sql = (mode: string, query = "", params: D1Value[] = []) => jobSqlite(join(dir, "case.db"), mode, query, params);
const stop = (scope = access, intent = "i") => stopBeforeDispatch(scope, intent);

describe("pre-dispatch owner stop", { timeout: 20_000 }, () => {
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "odap-stop-"));
    const db = { prepare: (query: string) => ({ bind: (...params: D1Value[]) => ({
      first: () => sql("first", query, params), run: () => sql("run", query, params)
    }) }) } as D1Database;
    access = { db, tenantId: "t", principalId: "owner" };
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("accepts an unprepared intent once and preserves the first owner and time across retries", async () => {
    await sql("setup");
    await sql("run", "INSERT INTO control_memberships VALUES('t','second','owner',1)");
    const [a, b] = await Promise.all([stop(), stop({ ...access, principalId: "second" })]);
    expect(a).toEqual(b);
    expect(a).toMatchObject({ state: "stopped", stoppedBy: expect.stringMatching(/^(owner|second)$/),
      stoppedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) });
    expect(await stop()).toEqual(a);
    await expect(sql("run", "UPDATE dispatch_stopped_intents SET reason='changed'")).rejects.toThrow("immutable");
    await expect(sql("run", "DELETE FROM dispatch_stopped_intents")).rejects.toThrow("immutable");
    expect(await sql("first", `SELECT (SELECT count(*) FROM dispatch_stopped_intents) AS stops,
      (SELECT count(*) FROM bigquery_job_bindings) AS jobs,(SELECT count(*) FROM evidence_receipts) AS receipts,
      (SELECT state FROM contract_lifecycle) AS contract,reserved_units,spent_units FROM control_budgets`))
      .toEqual({ stops: 1, jobs: 0, receipts: 0, contract: "consumed", reserved_units: 20, spent_units: 0 });
  });

  it("does not disclose intent or replay state to a reader, inactive owner or another tenant", async () => {
    await sql("setup");
    await sql("run", "INSERT INTO control_tenants VALUES('other','Other')");
    await sql("run", "INSERT INTO control_memberships VALUES('other','owner','owner',1),('t','inactive','owner',0)");
    const denied = [{ ...access, tenantId: "other" }, { ...access, principalId: "user" }, { ...access, principalId: "inactive" }];
    for (const scope of denied) await expect(stop(scope)).rejects.toThrow("stop unavailable");
    await expect(stop(access, "missing")).rejects.toThrow("stop unavailable");
    expect(await sql("first", "SELECT count(*) AS n FROM dispatch_stopped_intents")).toEqual({ n: 0 });
    await stop();
    for (const scope of denied) await expect(stop(scope)).rejects.toThrow("stop unavailable");
  });

  it.each([false, true])("preserves unattributed v10 stops, including an existing claim=%s", async claimed => {
    await sql("setup-v10");
    await prepareIntentJob(access, "i", { BIGQUERY_PROJECT_ID: "demo-project", BIGQUERY_LOCATION: "US" });
    if (claimed) await sql("run", `INSERT INTO dispatch_claims(tenant_id,intent_id,claimed_by,maximum_bytes_billed)
      VALUES('t','i','owner',64)`);
    await sql("run", "INSERT INTO dispatch_stopped_intents VALUES('t','i','legacy')");
    await sql("apply-pre-dispatch-stop");
    expect(await stop()).toEqual({ state: claimed ? "already-claimed" : "legacy-stop" });
    expect(await sql("first", "SELECT reason,stopped_by,stopped_at FROM dispatch_stopped_intents"))
      .toEqual({ reason: "legacy", stopped_by: null, stopped_at: null });
    expect(await sql("first", "SELECT reserved_units,spent_units FROM control_budgets")).toEqual({ reserved_units: 20, spent_units: 0 });
  });
});
