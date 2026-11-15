import { expect, it, vi } from "vitest";
import { postgresHostAdmission, PostgresHostBusy } from "../integrations/postgresql/admission";
import { postgresBarrier as deferred } from "./fixtures/postgresql";

it.each([0, -1, 1.5, 1001, NaN, Infinity, "1", null, true])("rejects invalid host admission limit %s", maximum => {
  expect(() => postgresHostAdmission(maximum as number)).toThrow("execution limit");
});
it("defaults to eight local executions and refuses excess without queuing", async () => {
  const admit = postgresHostAdmission(), done = deferred(), runs = Array.from({ length: 8 }, () => admit(() => done.promise));
  const extra = vi.fn(async () => undefined);
  await expect(admit(extra)).rejects.toBeInstanceOf(PostgresHostBusy);
  expect(extra).not.toHaveBeenCalled();
  done.resolve(); await Promise.all(runs);
  await admit(extra); expect(extra).toHaveBeenCalledOnce();
});
it("releases on success, synchronous throw and rejected operation", async () => {
  const admit = postgresHostAdmission(1);
  expect(await admit(async () => "done")).toBe("done");
  await expect(admit(() => { throw new Error("synthetic"); })).rejects.toThrow("synthetic");
  await expect(admit(async () => { throw new Error("synthetic"); })).rejects.toThrow("synthetic");
  expect(await admit(async () => "again")).toBe("again");
});
it("refuses pre-aborted admission without invoking work or leaking capacity", async () => {
  const admit = postgresHostAdmission(1), run = vi.fn(async () => 1);
  await expect(admit(run, AbortSignal.abort())).rejects.toThrow("aborted");
  expect(run).not.toHaveBeenCalled(); expect(await admit(run)).toBe(1);
});
it("keeps capacity until the actual operation settles after abort", async () => {
  const admit = postgresHostAdmission(1), done = deferred(), controller = new AbortController();
  const pending = admit(() => done.promise, controller.signal);
  controller.abort();
  await expect(admit(async () => 1)).rejects.toBeInstanceOf(PostgresHostBusy);
  done.resolve(); await pending;
  expect(await admit(async () => 1)).toBe(1);
});
it("does not change a separate host instance or persist a resource release", async () => {
  const first = postgresHostAdmission(1), second = postgresHostAdmission(1), done = deferred();
  const pending = first(() => done.promise);
  expect(await second(async () => "independent")).toBe("independent");
  await expect(first(async () => 1)).rejects.toBeInstanceOf(PostgresHostBusy);
  done.resolve(); await pending;
});
