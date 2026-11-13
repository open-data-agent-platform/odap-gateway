import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { requestJobCancellation } from "../lib/bigquery-cancellation";
import { sendRequestedJobCancellation } from "../lib/bigquery-cancellation-transport";
import { prepareIntentJob } from "../lib/bigquery-job-storage";
import type { ControlAccess } from "../lib/control-storage";
import type { D1Database } from "../lib/d1";
import { jobSqlite } from "./fixtures/job-sqlite";

let mf: Miniflare, db: D1Database, access: ControlAccess;
let statements: string[], sequence = 0;
const run = (sql: string) => db.prepare(sql).run();
const held = () => db.prepare(`SELECT reserved_units,spent_units,
  (SELECT count(*) FROM cost_settlements) AS settlements,
  (SELECT count(*) FROM evidence_receipts) AS receipts,
  (SELECT count(*) FROM bigquery_terminal_observations) AS observations,
  (SELECT count(*) FROM bigquery_cancellation_requests) AS requests FROM control_budgets`).first();

describe("cancellation transport on installed native D1", () => {
  beforeAll(async () => { statements = await jobSqlite(":memory:", "migration-statements"); });
  beforeEach(async () => {
    await mf?.dispose();
    mf = new Miniflare({ host: "127.0.0.1", port: 0, modules: true,
      script: "export default {fetch(){return new Response('Local cancellation test');}}",
      d1Databases: { DB: "local-cancellation-" + (++sequence) }, d1Persist: false });
    db = await mf.getD1Database("DB") as unknown as D1Database;
    await db.batch!(statements.map(sql => db.prepare(sql)));
    await db.batch!([
      db.prepare("INSERT INTO control_tenants VALUES('t','Tenant')"),
      db.prepare("INSERT INTO control_memberships VALUES('t','owner','owner',1),('t','user','reader',1)"),
      db.prepare("INSERT INTO semantic_releases(tenant_id,id,payload,created_by) VALUES('t','r',?,'owner')")
        .bind(JSON.stringify({ id: "r", tenantId: "t" })),
      db.prepare("INSERT INTO approval_contracts(tenant_id,id,release_id,payload,created_by) VALUES('t','c','r',?,'owner')")
        .bind(JSON.stringify({ id: "c", tenantId: "t", semanticReleaseId: "r", state: "authorized", principalId: "user", actionDigest: "digest",
          reservationId: "s", expiresAt: "2099-01-01T00:00:00.000Z" })),
      db.prepare("INSERT INTO control_budgets(tenant_id,id,limit_units) VALUES('t','b',100)"),
      db.prepare("INSERT INTO execution_intents VALUES('t','i','c','b','s','user','digest',20,'now')")
    ]);
    access = { db, tenantId: "t", principalId: "owner" };
    await prepareIntentJob(access, "i", { BIGQUERY_PROJECT_ID: "fixture-project", BIGQUERY_LOCATION: "US" });
    await run("INSERT INTO dispatch_claims(tenant_id,intent_id,claimed_by,maximum_bytes_billed) VALUES('t','i','owner',128)");
  }, 30000);
  afterAll(async () => { await mf?.dispose(); });
  it("requires a recorded request, then leaves accounting and evidence untouched after explicit sends", async () => {
    const getAccessToken = vi.fn(async () => "synthetic-token"), sendOnce = vi.fn(async () => new Response(null));
    expect(await sendRequestedJobCancellation(access, "i", { getAccessToken, sendOnce })).toMatchObject({ state: "not-sent", reason: "not-requested" });
    expect(getAccessToken).not.toHaveBeenCalled(); expect(sendOnce).not.toHaveBeenCalled();
    await requestJobCancellation(access, "i"); const before = await held();
    for (let i = 0; i < 2; i++) expect(await sendRequestedJobCancellation(access, "i", { getAccessToken, sendOnce }))
      .toMatchObject({ state: "observation-required" });
    expect(sendOnce).toHaveBeenCalledTimes(2); expect(await held()).toEqual(before);
  });
  it.each(["UPDATE control_memberships SET active=0 WHERE principal_id='owner'",
    "UPDATE control_memberships SET role='reader' WHERE principal_id='owner'"])("rejects changed authority after authentication: %s", async sql => {
    await requestJobCancellation(access, "i"); const before = await held(), sendOnce = vi.fn();
    await expect(sendRequestedJobCancellation(access, "i", { sendOnce, getAccessToken: async () => { await run(sql); return "synthetic-token"; } }))
      .rejects.toThrow("unavailable");
    expect(sendOnce).not.toHaveBeenCalled(); expect(await held()).toEqual(before);
  });
  it("does not send when a matched terminal observation wins during authentication", async () => {
    await requestJobCancellation(access, "i"); const sendOnce = vi.fn();
    expect(await sendRequestedJobCancellation(access, "i", { sendOnce, getAccessToken: async () => {
      await run("INSERT INTO bigquery_terminal_observations(tenant_id,intent_id,outcome,has_bytes,observed_by) VALUES('t','i','cancelled',0,'owner')");
      return "synthetic-token";
    } })).toMatchObject({ state: "not-sent", reason: "terminal" });
    expect(sendOnce).not.toHaveBeenCalled();
    expect(await held()).toMatchObject({ reserved_units: 20, spent_units: 0, settlements: 0, receipts: 1, observations: 1 });
  });
  it("requires the same tenant's current owner before preparing credentials", async () => {
    await requestJobCancellation(access, "i"); const getAccessToken = vi.fn(), sendOnce = vi.fn();
    for (const denied of [{ ...access, principalId: "user" }, { ...access, tenantId: "foreign" }])
      await expect(sendRequestedJobCancellation(denied, "i", { getAccessToken, sendOnce })).rejects.toThrow("unavailable");
    expect(getAccessToken).not.toHaveBeenCalled(); expect(sendOnce).not.toHaveBeenCalled();
  });
});
