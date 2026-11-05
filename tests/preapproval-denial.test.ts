import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ControlAccess } from "../lib/control-storage";
import type { D1Database, D1Value } from "../lib/d1";
import { recordMissingReleaseDenial } from "../lib/preapproval-denial";
import { jobSqlite } from "./fixtures/job-sqlite";

let dir: string, dbFile: string, member: ControlAccess;
const action = { target: "orders", metricId: "revenue", parameters: { year: 2026, region: "synthetic-private-value" } };
const sqlite = (mode: string, sql = "", params: D1Value[] = []) =>
  jobSqlite(join(dir, dbFile), mode, sql, params);
const deny = (scope = member, attempt = "try-1", agent = "agent", release = "missing", read = action) =>
  recordMissingReleaseDenial(scope, attempt, agent, release, read);
function counts() {
  return sqlite("first", `SELECT
    (SELECT count(*) FROM missing_release_denials WHERE tenant_id='isolated') AS denials,
    (SELECT count(*) FROM evidence_receipts WHERE tenant_id='isolated') AS receipts,
    (SELECT count(*) FROM control_object_events WHERE tenant_id='isolated' AND object_kind='receipt') AS events,
    (SELECT count(*) FROM approval_contracts WHERE tenant_id='isolated') AS contracts,
    (SELECT count(*) FROM execution_intents WHERE tenant_id='isolated') AS intents,
    (SELECT count(*) FROM bigquery_job_bindings WHERE tenant_id='isolated') AS jobs,
    (SELECT count(*) FROM dispatch_claims WHERE tenant_id='isolated') AS claims,
    (SELECT count(*) FROM cost_settlements WHERE tenant_id='isolated') AS settlements,
    reserved_units,spent_units,overrun_units FROM control_budgets WHERE tenant_id='isolated'`);
}
const zero = { denials: 0, receipts: 0, events: 0, contracts: 0, intents: 0, jobs: 0,
  claims: 0, settlements: 0, reserved_units: 0, spent_units: 0, overrun_units: 0 };

describe("missing-release refusal before approval", { timeout: 20_000 }, () => {
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "odap-refusal-"));
    dbFile = "fixture.db";
    await sqlite("setup");
    await sqlite("run", "INSERT INTO control_tenants VALUES('isolated','Fixture')");
    await sqlite("run", "INSERT INTO control_memberships VALUES('isolated','user','reader',1),('isolated','second','owner',1)");
    await sqlite("run", "INSERT INTO control_budgets(tenant_id,id,limit_units) VALUES('isolated','b',100)");
    const db = { prepare: (sql: string) => ({ bind: (...params: D1Value[]) => ({
      first: () => sqlite("first", sql, params), run: () => sqlite("run", sql, params)
    }) }) } as D1Database;
    member = { db, tenantId: "isolated", principalId: "user" };
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("concurrent retries produce one attributed receipt and audit event with no execution or cost", async () => {
    const [first, ...replays] = await Promise.all([deny(), deny(), deny()]);
    expect(replays).toEqual([first, first]);
    expect(first).toMatchObject({ outcome: "denied", tenantId: member.tenantId, intentId: "try-1",
      contractId: null, semanticReleaseId: null, reason: expect.stringContaining("no approval issued") });
    expect(await sqlite("first", "SELECT actor,object_id FROM control_object_events WHERE tenant_id='isolated'"))
      .toEqual({ actor: "user", object_id: first.id });
    const attempt = await sqlite("first", "SELECT * FROM missing_release_denials");
    expect(attempt).toMatchObject({ principal_id: "user", agent_id: "agent", requested_release: "missing",
      action_digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) });
    expect(JSON.stringify([attempt, first])).not.toContain("synthetic-private-value");
    expect(await counts()).toEqual({ ...zero, denials: 1, receipts: 1, events: 1 });
  });

  it("keeps the original decision after publication, but cannot deny an existing release on a fresh attempt", async () => {
    // 'r' already exists in the other tenant; it is absent here.
    const first = await deny(member, "try-1", "agent", "r");
    await sqlite("run", `INSERT INTO semantic_releases(tenant_id,id,payload,created_by)
      SELECT 'isolated',id,json_set(payload,'$.tenantId','isolated'),'second' FROM semantic_releases WHERE tenant_id='t'`);
    expect(await deny(member, "try-1", "agent", "r")).toEqual(first);
    await expect(deny(member, "try-2", "agent", "r")).rejects.toThrow("unavailable");
    expect(await counts()).toEqual({ ...zero, denials: 1, receipts: 1, events: 1 });
  });

  it("isolates tenant-local keys and rejects changed principals, agents, releases and actions", async () => {
    const first = await deny();
    const otherTenant = await deny({ ...member, tenantId: "t" });
    expect(otherTenant.tenantId).toBe("t");
    expect(otherTenant.intentId).toBe(first.intentId);
    await expect(deny({ ...member, principalId: "second" })).rejects.toThrow("unavailable");
    await expect(deny(member, "try-1", "different-agent")).rejects.toThrow("unavailable");
    await expect(deny(member, "try-1", "agent", "other-release")).rejects.toThrow("unavailable");
    await expect(deny(member, "try-1", "agent", "missing", { ...action, metricId: "other" })).rejects.toThrow("unavailable");
    await sqlite("run", "UPDATE control_memberships SET active=0 WHERE tenant_id='isolated' AND principal_id='user'");
    await expect(deny()).rejects.toThrow("unavailable");
    await expect(deny(member, "new")).rejects.toThrow("unavailable");
    await expect(deny({ ...member, tenantId: "unknown" })).rejects.toThrow("unavailable");
    expect(await counts()).toEqual({ ...zero, denials: 1, receipts: 1, events: 1 });
  });

  it("never repurposes an admitted intent or admits an already denied attempt", async () => {
    const t = { ...member, tenantId: "t" };
    await expect(deny(t, "i")).rejects.toThrow("unavailable");
    await deny(t, "retry");
    await sqlite("run", `INSERT INTO approval_contracts(tenant_id,id,release_id,payload,created_by)
      SELECT tenant_id,'c2',release_id,json_set(payload,'$.id','c2','$.reservationId','s2'),created_by
      FROM approval_contracts WHERE tenant_id='t' AND id='c'`);
    const admit = (id: string) => sqlite("run", `INSERT INTO execution_intents
      SELECT tenant_id,?,'c2',budget_id,'s2',principal_id,action_digest,reserved_units,created_at
      FROM execution_intents WHERE tenant_id='t' AND id='i'`, [id]);
    await expect(admit("retry")).rejects.toThrow("attempt already denied");
    expect(await sqlite("first", "SELECT reserved_units FROM control_budgets WHERE tenant_id='t'")).toEqual({ reserved_units: 20 });
    await admit("fresh");
    expect(await sqlite("first", "SELECT reserved_units FROM control_budgets WHERE tenant_id='t'")).toEqual({ reserved_units: 40 });
  });

  it("rolls back the refusal and receipt if audit fails and protects the stored decision on retry", async () => {
    await sqlite("run", `CREATE TRIGGER fail_audit BEFORE INSERT ON control_object_events WHEN NEW.object_kind='receipt'
      BEGIN SELECT RAISE(ABORT,'fixture failure'); END`);
    await expect(deny()).rejects.toThrow("fixture failure");
    expect(await counts()).toEqual(zero);
    await sqlite("run", "DROP TRIGGER fail_audit");
    const first = await deny();
    await expect(sqlite("run", "UPDATE missing_release_denials SET agent_id='other'")).rejects.toThrow("immutable");
    await expect(sqlite("run", "DELETE FROM missing_release_denials")).rejects.toThrow("immutable");
    await expect(sqlite("run", `INSERT OR REPLACE INTO missing_release_denials
      SELECT tenant_id,attempt_id,principal_id,'other',requested_release,action_digest,receipt_id,recorded_at FROM missing_release_denials`))
      .rejects.toThrow("unavailable");
    expect(await deny()).toEqual(first);
  });

  it("does not let the generic receipt writer claim the refusal namespace", async () => {
    await expect(sqlite("run", `INSERT INTO evidence_receipts(tenant_id,id,contract_id,release_id,payload,created_by)
      VALUES('isolated','denied_preapproval_try-1',NULL,NULL,?,'second')`, [JSON.stringify({
      id: "denied_preapproval_try-1", tenantId: "isolated", intentId: "try-1", contractId: null, semanticReleaseId: null, outcome: "denied"
    })])).rejects.toThrow("pre-approval denial required");
    expect(await counts()).toEqual(zero);
  });

  it("does not adopt or overwrite a legacy receipt that collides with a new attempt ID", async () => {
    dbFile = "legacy.db";
    await sqlite("setup-v9");
    const old = { schemaVersion: "0.1", id: "denied_preapproval_try-1", tenantId: "t", intentId: "try-1",
      contractId: null, semanticReleaseId: null, outcome: "denied", reason: "historical fixture",
      recordedAt: "2026-01-01T00:00:00.000Z" };
    await sqlite("run", "INSERT INTO evidence_receipts(tenant_id,id,payload,created_by) VALUES('t',?,?,'owner')",
      [old.id, JSON.stringify(old)]);
    await sqlite("apply-preapproval-denials");
    await expect(deny({ ...member, tenantId: "t" })).rejects.toThrow("unavailable");
    expect(await sqlite("first", "SELECT payload,created_by FROM evidence_receipts WHERE tenant_id='t' AND id=?", [old.id]))
      .toEqual({ payload: JSON.stringify(old), created_by: "owner" });
    expect(await sqlite("first", "SELECT count(*) AS denials FROM missing_release_denials")).toEqual({ denials: 0 });
  });
});
