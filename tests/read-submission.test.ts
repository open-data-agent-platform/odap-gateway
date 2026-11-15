import { describe, expect, it, vi } from "vitest";
import { submitPreparedRead } from "../lib/read-submission";

describe("trusted-host read submission boundary", () => {
  it("prepares, confirms a claim, then sends exactly once", async () => {
    const order: string[] = [];
    const send = vi.fn(async () => { order.push("send"); return "result"; });
    const prepare = vi.fn(async () => { order.push("prepare"); return send; });
    const claim = vi.fn(async () => { order.push("claim"); return true; });
    expect(await submitPreparedRead(prepare, claim)).toBe("result");
    expect(order).toEqual(["prepare", "claim", "send"]);
    for (const call of [prepare, claim, send]) expect(call).toHaveBeenCalledTimes(1);
  });
  it("does not claim after preparation fails", async () => {
    const failure = new Error("fixture preparation failure"), claim = vi.fn();
    await expect(submitPreparedRead(async () => { throw failure; }, claim)).rejects.toBe(failure);
    expect(claim).not.toHaveBeenCalled();
  });
  it.each([null, undefined, {}, "send"])("refuses invalid preparation %j before claiming", async value => {
    const claim = vi.fn();
    await expect(submitPreparedRead(async () => value as never, claim)).rejects.toThrow("failed to prepare");
    expect(claim).not.toHaveBeenCalled();
  });
  it.each([false, undefined, null, 1, "true", {}, { success: true }])("requires literal confirmation, not %j", async value => {
    const send = vi.fn(), claim = vi.fn(async () => value as boolean);
    const failure = new Error("host-specific refusal");
    await expect(submitPreparedRead(async () => send, claim, failure)).rejects.toBe(failure);
    expect(claim).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
  });
  it("does not send or retry after an ambiguous claim exception", async () => {
    const failure = new Error("fixture commit response lost"), send = vi.fn();
    const claim = vi.fn(async () => { throw failure; });
    await expect(submitPreparedRead(async () => send, claim)).rejects.toBe(failure);
    expect(claim).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
  });
  it("preserves sender failure and never retries or rolls back the claim", async () => {
    const failure = new Error("fixture acknowledgment lost");
    const send = vi.fn(async () => { throw failure; }), claim = vi.fn(async () => true);
    await expect(submitPreparedRead(async () => send, claim)).rejects.toBe(failure);
    expect(send).toHaveBeenCalledTimes(1);
    expect(claim).toHaveBeenCalledTimes(1);
  });
});
