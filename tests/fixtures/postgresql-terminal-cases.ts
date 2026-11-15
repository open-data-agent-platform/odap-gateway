import { expect, it } from "vitest";
import type { D1Database } from "../../lib/d1";
import { isEvidenceReceipt } from "../../lib/control-objects";
import { recordPostgresFailure, type PostgresFailureCode } from "../../lib/postgresql-terminal";
import { claimPostgresRead, inspectPostgresRead, observePostgresRead, preparePostgresDispatch } from "../../lib/postgresql-control";
import { approvePostgresFixture, pgAccess, pgRun, publishPostgresFixture } from "./postgresql-control";

export function postgresTerminalCases(getDb: () => D1Database) {
  async function start() {
    const db = getDb(); await publishPostgresFixture(db); await approvePostgresFixture(db);
    const { row } = await preparePostgresDispatch(pgAccess(db), "request");
    expect(await claimPostgresRead(pgAccess(db), row, "attempt")).toBe(true);
    return { db, digest: row.statement_digest };
  }
  it.each(["57014", "42501"] as const)("appends acknowledged %s failure without refund or replay", async code => {
    const { db, digest } = await start();
    expect(await recordPostgresFailure(pgAccess(db), "request", "attempt", digest, code)).toBe(true);
    expect(await inspectPostgresRead(pgAccess(db), "request")).toMatchObject({ state: "failed", terminal_sql_state: code,
      used_attempts: 1, receiptIds: ["pg-pending-attempt", "pg-failed-attempt"], monetaryCost: "unpriced" });
    const receipt = await db.prepare("SELECT payload FROM evidence_receipts WHERE tenant_id='tenant-a' AND id='pg-failed-attempt'").bind().first<{ payload: string }>();
    expect(isEvidenceReceipt(JSON.parse(receipt!.payload))).toBe(true);
    expect(JSON.parse(receipt!.payload).outcome).toBe("failed");
    await expect(preparePostgresDispatch(pgAccess(db), "request")).rejects.toThrow();
    expect(await db.prepare("PRAGMA foreign_key_check").bind().first()).toBeNull();
  });
  it("preserves a pending observation when appending later acknowledged failure", async () => {
    const { db, digest } = await start();
    await observePostgresRead(pgAccess(db), "request", "attempt", "observation-required");
    const before = await db.prepare("SELECT payload FROM evidence_receipts WHERE tenant_id='tenant-a' AND id='pg-observed-attempt'").bind().first();
    await recordPostgresFailure(pgAccess(db), "request", "attempt", digest, "57014");
    expect(await db.prepare("SELECT payload FROM evidence_receipts WHERE tenant_id='tenant-a' AND id='pg-observed-attempt'").bind().first()).toEqual(before);
    expect(await inspectPostgresRead(pgAccess(db), "request")).toMatchObject({ state: "failed",
      receiptIds: ["pg-pending-attempt", "pg-observed-attempt", "pg-failed-attempt"] });
  });
  it.each(["principal", "tenant", "intent", "digest"])("rejects substituted terminal %s", async field => {
    const { db, digest } = await start();
    expect(await recordPostgresFailure(pgAccess(db, field === "principal" ? "other-reader" : "reader", field === "tenant" ? "tenant-b" : "tenant-a"),
      "request", field === "intent" ? "other" : "attempt", field === "digest" ? "sha256:" + "0".repeat(64) : digest, "57014")).toBe(false);
    expect(await inspectPostgresRead(pgAccess(db), "request")).toMatchObject({ state: "observation-required" });
  });
  it("rejects unsupported terminal codes in both API and storage", async () => {
    const { db, digest } = await start();
    await expect(recordPostgresFailure(pgAccess(db), "request", "attempt", digest, "08006" as PostgresFailureCode)).rejects.toThrow();
    await expect(pgRun(db, "INSERT INTO postgresql_terminal_failures(tenant_id,request_id,intent_id,statement_digest,sql_state) VALUES('tenant-a','request','attempt',?,'08006')", [digest])).rejects.toThrow();
  });
  it("keeps terminal history immutable and disallows observations after final failure", async () => {
    const { db, digest } = await start(); await recordPostgresFailure(pgAccess(db), "request", "attempt", digest, "57014");
    for (const sql of ["UPDATE postgresql_terminal_failures SET sql_state='42501'", "DELETE FROM postgresql_terminal_failures",
      "INSERT OR REPLACE INTO postgresql_terminal_failures SELECT * FROM postgresql_terminal_failures"])
      await expect(pgRun(db, sql)).rejects.toThrow();
    for (const outcome of ["succeeded", "observation-required"] as const)
      await expect(observePostgresRead(pgAccess(db), "request", "attempt", outcome)).rejects.toThrow();
  });
  it("does not replace a confirmed success with a failure", async () => {
    const { db, digest } = await start(); await observePostgresRead(pgAccess(db), "request", "attempt", "succeeded");
    await expect(recordPostgresFailure(pgAccess(db), "request", "attempt", digest, "57014")).rejects.toThrow();
    expect(await inspectPostgresRead(pgAccess(db), "request")).toMatchObject({ state: "succeeded" });
  });
  it("rolls back terminal state when its evidence receipt cannot be appended", async () => {
    const { db, digest } = await start();
    await pgRun(db, "CREATE TRIGGER synthetic_terminal_receipt_failure BEFORE INSERT ON evidence_receipts WHEN NEW.id='pg-failed-attempt' BEGIN SELECT RAISE(ABORT,'synthetic'); END");
    await expect(recordPostgresFailure(pgAccess(db), "request", "attempt", digest, "57014")).rejects.toThrow();
    expect(await inspectPostgresRead(pgAccess(db), "request")).toMatchObject({ state: "observation-required", used_attempts: 1 });
    expect(await db.prepare("SELECT count(*) AS n FROM postgresql_terminal_failures").bind().first()).toEqual({ n: 0 });
  });
  it("retains trusted completion evidence even when authority was revoked after claim", async () => {
    const { db, digest } = await start(); await pgRun(db, "UPDATE postgresql_source_heads SET active=0");
    expect(await recordPostgresFailure(pgAccess(db), "request", "attempt", digest, "42501")).toBe(true);
    expect(await inspectPostgresRead(pgAccess(db), "request")).toMatchObject({ state: "failed", used_attempts: 1 });
  });
}
