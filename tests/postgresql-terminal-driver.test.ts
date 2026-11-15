import { DatabaseError } from "pg";
import { expect, it, vi } from "vitest";
import { acknowledgePostgresFailure } from "../integrations/postgresql/terminal";

function provider(code: string, severity = "ERROR") {
  const e = new DatabaseError("synthetic untrusted diagnostic", 0, "error");
  e.code = code; e.severity = severity; return e;
}
it.each(["57014", "42501"])("acknowledges only bounded provider failure %s after rollback", async code => {
  const rollback = vi.fn(async () => undefined);
  expect(await acknowledgePostgresFailure(provider(code), rollback, () => false))
    .toEqual({ outcome: "failed", claim: "confirmed", sqlState: code });
  expect(rollback).toHaveBeenCalledOnce();
});
it.each(["08006", "57P01", "XX000", "55P03", "22003"])("keeps unsupported provider code %s uncertain", async code => {
  const rollback = vi.fn();
  expect(await acknowledgePostgresFailure(provider(code), rollback, () => false)).toBeNull();
  expect(rollback).not.toHaveBeenCalled();
});
it("does not trust a local error or plain object carrying a cancellation code", async () => {
  for (const error of [{ code: "57014", severity: "ERROR" }, Object.assign(new Error("local"), { code: "57014", severity: "ERROR" })]) {
    expect(await acknowledgePostgresFailure(error, vi.fn(), () => false)).toBeNull();
  }
});
it.each(["WARNING", "FATAL", "PANIC"])("does not infer a terminal query result from %s", async severity => {
  expect(await acknowledgePostgresFailure(provider("57014", severity), vi.fn(), () => false)).toBeNull();
});
it("keeps an aborted connection uncertain", async () => {
  const rollback = vi.fn();
  expect(await acknowledgePostgresFailure(provider("57014"), rollback, () => true)).toBeNull();
  expect(rollback).not.toHaveBeenCalled();
});
it("keeps a lost rollback acknowledgement uncertain", async () => {
  expect(await acknowledgePostgresFailure(provider("57014"), async () => { throw new Error("lost"); }, () => false)).toBeNull();
});
it("rechecks stop after rollback acknowledgement", async () => {
  let stopped = false;
  expect(await acknowledgePostgresFailure(provider("57014"), async () => { stopped = true; }, () => stopped)).toBeNull();
});
