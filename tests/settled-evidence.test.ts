import { constants } from "node:fs";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { reconcileBigQueryBill } from "../lib/bigquery-billing";
import { prepareIntentJob } from "../lib/bigquery-job-storage";
import { canonicalControlJson } from "../lib/control-objects";
import type { ControlAccess } from "../lib/control-storage";
import type { D1Database, D1Value } from "../lib/d1";
import { dispatchPreparedMetricRead } from "../lib/dispatch-authority";
import { verifySettledEvidence } from "../lib/settled-evidence";
import { exportSettledEvidence } from "../lib/settled-evidence-export";
import revenue from "./fixtures/revenue-metric.json";
import { jobSqlite } from "./fixtures/job-sqlite";

const scope = { tenantId: "t", intentId: "i" };
let dir: string, reader: ControlAccess, exported: { json: string; digest: string };
let pending: Awaited<ReturnType<typeof exportSettledEvidence>>;
const sqlite = (mode: string, sql = "", params: D1Value[] = []) => jobSqlite(join(dir, "test.db"), mode, sql, params);

function database(file: string, readOnly: boolean) {
  return { prepare: (sql: string) => ({ bind: (...params: D1Value[]) => ({
    first: () => jobSqlite(file, readOnly ? "readonly-first" : "first", sql, params),
    run: () => jobSqlite(file, readOnly ? "readonly-first" : "run", sql, params)
  }) }) } as D1Database;
}

describe("settled BigQuery evidence", () => {
  beforeAll(async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network disabled"));
    dir = await mkdtemp(join(tmpdir(), "odap-evidence-"));
    await sqlite("setup");
    const live = join(dir, "test.db");
    const writer = { db: database(live, false), tenantId: scope.tenantId, principalId: "owner" };
    reader = { ...writer, db: database(live, true) };
    await prepareIntentJob(writer, "i", { BIGQUERY_PROJECT_ID: "demo-project", BIGQUERY_LOCATION: "US" });
    await sqlite("run", "INSERT INTO dispatch_targets VALUES('t','orders','r','p1','s1','demo-project','US')");
    await sqlite("run", "INSERT INTO dispatch_read_grants VALUES('t','orders','user','agent','p1')");
    await sqlite("run", `INSERT INTO bigquery_scan_policies VALUES
      ('t','orders','p1','demo-project','US','on_demand',262144,100000000,'2080-01-01T00:00:00.000Z','fixture')`);
    await dispatchPreparedMetricRead(writer, "i", { principalId: "user", agentId: "agent" },
      { target: "orders", metricId: "revenue", parameters: { year: 2026 } }, {
        projectId: "demo-project", location: "US", loadDefinition: async () => JSON.stringify(revenue),
        prepareRead: async () => async () => "synthetic"
      });
    await sqlite("run", `INSERT INTO bigquery_terminal_observations
      (tenant_id,intent_id,outcome,has_bytes,observed_by) VALUES('t','i','cancelled',0,'owner')`);
    pending = await exportSettledEvidence(reader, "i");
    await sqlite("run", "VACUUM INTO ?", [join(dir, "pending.snapshot")]);
    await reconcileBigQueryBill(writer, "i", async key => ({ ...key, reference: "fixture:charge01",
      unit: "micro-USD", status: "final", amount: 0 }));
    const result = await exportSettledEvidence(reader, "i");
    if (!result) throw new Error("Missing fixture export");
    exported = result;
    await sqlite("run", "VACUUM INTO ?", [join(dir, "settled.snapshot")]);
  }, 30_000);
  afterAll(async () => { vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); });

  it.each(["pending", "settled"] as const)("restores the %s snapshot without inventing or losing final evidence", async phase => {
    const restored = join(dir, phase + "-restored.db");
    await copyFile(join(dir, phase + ".snapshot"), restored, constants.COPYFILE_EXCL);
    const query = (sql: string) => jobSqlite(restored, "readonly-first", sql);
    expect(await query("PRAGMA integrity_check")).toEqual({ integrity_check: "ok" });
    expect(await query("PRAGMA foreign_key_check")).toBeNull();
    const result = await exportSettledEvidence({ ...reader, db: database(restored, true) }, scope.intentId);
    if (phase === "pending") {
      expect(result).toBeNull();
      expect(await query(`SELECT (SELECT count(*) FROM evidence_receipts) AS receipts,
        (SELECT json_extract(payload,'$.outcome') FROM evidence_receipts) AS outcome,
        (SELECT count(*) FROM cost_settlements) AS settlements, reserved_units FROM control_budgets`))
        .toEqual({ receipts: 1, outcome: "pending", settlements: 0, reserved_units: 20 });
    } else {
      if (!result) throw new Error("Restored settled evidence missing");
      expect(result.json).toBe(exported.json);
      expect(await verifySettledEvidence(result.json, scope, exported.digest)).toMatchObject({
        digest: exported.digest, consistent: true, issuerAuthenticated: false, outcome: "cancelled", actualMicroUsd: 0
      });
    }
  });

  it("reproduces the portable synthetic file from the settled SQLite fixture", async () => {
    const data = JSON.parse(exported.json);
    // Freeze only database-clock fields; every link and amount comes from the export.
    data.pending.recordedAt = "2026-01-01T00:00:00.000Z";
    data.job.claimedAt = "2026-01-01T00:00:01.000Z";
    data.observation.observedAt = "2026-01-01T00:00:02.000Z";
    data.final.recordedAt = data.bill.recordedAt = "2026-01-01T00:00:03.000Z";
    await expect(canonicalControlJson(data)).toMatchFileSnapshot("./fixtures/settled-job.json");
  });

  it("round-trips a settled snapshot over a read-only connection without disclosing query data", async () => {
    await expect(verifySettledEvidence(exported.json, scope, exported.digest)).resolves.toMatchObject({
      consistent: true, issuerAuthenticated: false, digest: exported.digest, outcome: "cancelled", actualMicroUsd: 0
    });
    expect(JSON.parse(exported.json).observation.billedBytes).toBeNull();
    expect(exported.json).not.toMatch(/SELECT |net_amount|order_year|queryParameters|access_token/i);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    await sqlite("run", `INSERT INTO bigquery_terminal_observations
      (tenant_id,intent_id,outcome,has_bytes,billed_bytes,observed_by) VALUES('t','i','cancelled',1,0,'owner')`);
    expect(await exportSettledEvidence(reader, "i")).toEqual(exported);
  });

  it("withholds incomplete, missing, cross-tenant and unauthorized records", async () => {
    expect(pending).toBeNull();
    expect(await exportSettledEvidence(reader, "i", "requires-delegation")).toBeNull();
    expect(await exportSettledEvidence(reader, "missing")).toBeNull();
    expect(await exportSettledEvidence({ ...reader, tenantId: "other" }, "i")).toBeNull();
    expect(await exportSettledEvidence({ ...reader, principalId: "user" }, "i")).toBeNull();
    await sqlite("run", "INSERT INTO control_memberships VALUES('t','inactive','owner',0)");
    expect(await exportSettledEvidence({ ...reader, principalId: "inactive" }, "i")).toBeNull();
  });

  it("does not apply an active owner grant from a different tenant to a settled export", async () => {
    await sqlite("run", "INSERT INTO control_tenants VALUES('peer','Peer tenant')");
    await sqlite("run", "INSERT INTO control_memberships VALUES('peer','user','owner',1)");
    // Same principal is a reader here and an owner elsewhere. Neither scope
    // may yield the settled receipt; the actual resource owner still gets it.
    expect(await exportSettledEvidence({ ...reader, principalId: "user" }, "i")).toBeNull();
    expect(await exportSettledEvidence({ ...reader, tenantId: "peer", principalId: "user" }, "i")).toBeNull();
    expect(await exportSettledEvidence(reader, "i")).toEqual(exported);
  });

  it.each([
    ["release", "id", "substitute"], ["contract", "semanticReleaseId", "other"],
    ["intent", "actionDigest", "other"], ["job", "actionTag", "other"], ["job", "jobId", "other"],
    ["pending", "id", "other"], ["observation", "intentId", "elsewhere"], ["observation", "outcome", "failed"],
    ["final", "outcome", "succeeded"], ["bill", "receiptId", "other"], ["settlement", "actualMicroUsd", 1],
    ["bill", "reference", ""], ["settlement", "tenantId", "other"], ["job", "maximumBytesBilled", 0],
    ["settlement", "actor", "other"], ["observation", "observedAt", "invalid"]
  ])("rejects a substituted %s.%s even without a pinned checksum", async (part, key, value) => {
    const data = JSON.parse(exported.json);
    data[part][key] = value;
    await expect(verifySettledEvidence(canonicalControlJson(data), scope)).rejects.toThrow();
  });

  it("rejects missing records, unexpected payload and noncanonical input", async () => {
    const data = JSON.parse(exported.json);
    for (const part of Object.keys(data)) {
      const partial = { ...data };
      delete partial[part];
      await expect(verifySettledEvidence(canonicalControlJson(partial), scope)).rejects.toThrow();
    }
    data.job.queryText = "unexpected";
    await expect(verifySettledEvidence(canonicalControlJson(data), scope)).rejects.toThrow("Invalid evidence records");
    await expect(verifySettledEvidence(exported.json + "\n", scope)).rejects.toThrow("Noncanonical");
    await expect(verifySettledEvidence('{"profile":"other",' + exported.json.slice(1), scope)).rejects.toThrow("Noncanonical");
    await expect(verifySettledEvidence(exported.json, { ...scope, intentId: "other" })).rejects.toThrow("scope mismatch");
  });

  it("distinguishes internally consistent edits from an independently retained checksum", async () => {
    const data = JSON.parse(exported.json);
    data.bill.actualMicroUsd = data.settlement.actualMicroUsd = 12;
    const altered = canonicalControlJson(data);
    expect(await verifySettledEvidence(altered, scope)).toMatchObject({ consistent: true, issuerAuthenticated: false });
    await expect(verifySettledEvidence(altered, scope, exported.digest)).rejects.toThrow("checksum mismatch");
  });
});
