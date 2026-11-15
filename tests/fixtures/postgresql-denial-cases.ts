import { expect, it } from "vitest";
import type { D1Database, D1Value } from "../../lib/d1";
import { canonicalControlJson, isEvidenceReceipt, sha256Text } from "../../lib/control-objects";
import { requestPostgresRead } from "../../lib/postgresql-control";
import { pgAccess, pgAction, pgRun, publishPostgresFixture } from "./postgresql-control";

export function postgresDenialCases(database: () => D1Database) {
  const action = { ...pgAction, parameters: { region: "synthetic-private-filter" } };
  const request = (db = database(), releaseId = "missing", value: unknown = action, principal = "reader", tenant = "tenant-a") =>
    requestPostgresRead(pgAccess(db, principal, tenant), { requestId: "request", releaseId, action: value });
  const count = async (table: string) => (await database().prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
  const noExecution = async () => {
    for (const table of ["postgresql_read_requests", "postgresql_read_approvals", "postgresql_read_claims", "approval_contracts"])
      expect(await count(table)).toBe(0);
    expect(await database().prepare("SELECT unresolved_claims AS n FROM postgresql_resource_usage").first("n")).toBe(0);
  };
  it("records an attributed missing-release refusal without values, approval or execution", async () => {
    await expect(request()).rejects.toThrow("PostgreSQL control operation unavailable");
    const row = await database().prepare("SELECT * FROM missing_release_denials").first<Record<string, string>>();
    expect(row).toMatchObject({ tenant_id: "tenant-a", principal_id: "google:reader", agent_id: "postgresql-session",
      requested_release: "missing", action_digest: await sha256Text(canonicalControlJson(action)) });
    expect(row!.attempt_id).toMatch(/^pg-missing-[0-9a-f-]{36}$/);
    const stored = await database().prepare("SELECT payload FROM evidence_receipts WHERE id=?").bind(row!.receipt_id).first<{ payload: string }>();
    const receipt = JSON.parse(stored!.payload);
    expect(isEvidenceReceipt(receipt)).toBe(true);
    expect(receipt).toMatchObject({ outcome: "denied", intentId: row!.attempt_id, contractId: null, semanticReleaseId: null });
    expect(JSON.stringify([row, receipt])).not.toContain("synthetic-private-filter");
    expect(await count("control_object_events")).toBe(1); await noExecution();
  });
  it("records separate server-assigned attempts for concurrent refusals without admitting reads", async () => {
    const results = await Promise.allSettled([request(), request(), request()]);
    expect(results.every(result => result.status === "rejected")).toBe(true);
    expect(await count("missing_release_denials")).toBe(3);
    expect(await count("evidence_receipts")).toBe(3); await noExecution();
  });
  it.each(["inactive", "unknown"])("does not persist an %s principal's assertion", async mode => {
    if (mode === "inactive") await pgRun(database(), "UPDATE control_memberships SET active=0 WHERE principal_id='google:reader'");
    await expect(request(database(), "missing", action, mode === "unknown" ? "unknown" : "reader")).rejects.toThrow();
    expect(await count("missing_release_denials")).toBe(0); await noExecution();
  });
  it.each([
    ["SQL field", { ...pgAction, sql: "SELECT private_value" }], ["profile", { ...pgAction, profile: "unknown" }],
    ["nested value", { ...pgAction, parameters: { nested: { value: "private" } } }],
    ["oversized value", { ...pgAction, parameters: { region: "x".repeat(4097) } }],
    ["parameter name", { ...pgAction, parameters: { "bad-key": "private" } }],
  ])("rejects malformed %s without trusting an audit assertion", async (_, bad) => {
    await expect(request(database(), "missing", bad)).rejects.toThrow();
    expect(await count("missing_release_denials")).toBe(0); await noExecution();
  });
  it("keeps false and null action digests distinct without persisting their values", async () => {
    for (const value of [false, null]) await expect(request(database(), "missing", { ...pgAction, parameters: { flag: value } })).rejects.toThrow();
    expect(await database().prepare("SELECT count(DISTINCT action_digest) AS n FROM missing_release_denials").first("n")).toBe(2);
    await noExecution();
  });
  it("does not classify a published or retired release as missing", async () => {
    await publishPostgresFixture(database());
    expect(await request(database(), "release", pgAction)).toMatchObject({ state: "awaiting-approval" });
    await pgRun(database(), "UPDATE postgresql_source_heads SET active=0 WHERE tenant_id='tenant-a'");
    await expect(request(database(), "release", pgAction)).rejects.toThrow();
    expect(await count("missing_release_denials")).toBe(0); expect(await count("postgresql_read_claims")).toBe(0);
  });
  it("records only the requesting tenant's missing release, even when another tenant has that ID", async () => {
    await publishPostgresFixture(database());
    await expect(request(database(), "release", pgAction, "reader", "tenant-b")).rejects.toThrow();
    expect(await database().prepare("SELECT tenant_id,requested_release FROM missing_release_denials").first())
      .toEqual({ tenant_id: "tenant-b", requested_release: "release" });
    await noExecution();
  });
  function hook(before: () => Promise<void>, loseAck = false) {
    const db = database();
    return { prepare(sql: string) {
      if (!sql.includes("INSERT INTO missing_release_denials")) return db.prepare(sql);
      return { bind(...values: D1Value[]) { const statement = db.prepare(sql).bind(...values);
        return { run: async () => { await before(); const result = await statement.run();
          if (loseAck) throw new Error("Synthetic lost denial write acknowledgement"); return result; } }; } };
    } } as D1Database;
  }
  it("rechecks release absence atomically after a concurrent publication", async () => {
    await expect(request(hook(() => publishPostgresFixture(database())), "release", pgAction)).rejects.toThrow();
    expect(await count("missing_release_denials")).toBe(0); await noExecution();
  });
  it("rolls back the denial if its receipt cannot be appended", async () => {
    await pgRun(database(), `CREATE TRIGGER fixture_refuse_denial BEFORE INSERT ON evidence_receipts
      WHEN NEW.id GLOB 'denied_preapproval_*' BEGIN SELECT RAISE(ABORT,'synthetic receipt failure'); END`);
    await expect(request()).rejects.toThrow();
    expect(await count("missing_release_denials")).toBe(0); expect(await count("evidence_receipts")).toBe(0); await noExecution();
  });
  it("keeps a committed denial after lost acknowledgement without executing or retrying its write", async () => {
    await expect(request(hook(async () => {}, true))).rejects.toThrow();
    expect(await count("missing_release_denials")).toBe(1); expect(await count("evidence_receipts")).toBe(1); await noExecution();
  });
}
