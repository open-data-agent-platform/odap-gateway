import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { monitorPostgresCancellation, sendPostgresCancellation } from "../integrations/postgresql/cancellation";
import type { PostgresHostConfig } from "../integrations/postgresql";

const factory = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("pg", () => ({ Connection: function (config: unknown) { return factory.create(config); } }));
const config: PostgresHostConfig = { host: "database.example.test", port: 5432, database: "fixture", user: "reader",
  password: "synthetic-only", tls: { ca: "synthetic-ca" }, statementTimeoutMs: 1000, lockTimeoutMs: 100, deadlineMs: 3000 };
const key = { processID: 123, secretKey: 456 }; // Synthetic protocol data only.
let connection: EventEmitter & { stream: EventEmitter & { authorized: boolean; destroy: ReturnType<typeof vi.fn> };
  connect: ReturnType<typeof vi.fn>; requestSsl: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> };
beforeEach(() => {
  vi.useFakeTimers();
  connection = Object.assign(new EventEmitter(), { stream: Object.assign(new EventEmitter(), { authorized: false, destroy: vi.fn() }),
    connect: vi.fn(), requestSsl: vi.fn(), cancel: vi.fn() });
  factory.create.mockReset().mockReturnValue(connection);
});
afterEach(() => { expect(vi.getTimerCount()).toBe(0); vi.useRealTimers(); });

describe("PostgreSQL cancellation channel", () => {
  it("sends only after certificate verification and never treats disconnect as a terminal result", async () => {
    const pending = sendPostgresCancellation(config, key, new AbortController().signal);
    expect(factory.create).toHaveBeenCalledWith({ ssl: { rejectUnauthorized: true, ca: "synthetic-ca" } });
    connection.emit("connect"); expect(connection.requestSsl).toHaveBeenCalledOnce();
    connection.emit("sslconnect"); expect(connection.cancel).not.toHaveBeenCalled();
    connection.stream.authorized = true; connection.stream.emit("secureConnect");
    expect(connection.cancel).toHaveBeenCalledOnce(); expect(connection.cancel).toHaveBeenCalledWith(123, 456);
    connection.stream.emit("secureConnect"); connection.emit("end");
    expect(await pending).toBeUndefined(); expect(connection.stream.destroy).toHaveBeenCalledOnce();
  });
  it.each(["error", "errorMessage", "untrusted", "timeout", "abort"])("does not send on %s or late TLS callbacks", async failure => {
    const abort = new AbortController(); const pending = sendPostgresCancellation(config, key, abort.signal);
    connection.emit("connect"); connection.emit("sslconnect");
    if (failure === "untrusted") connection.stream.emit("secureConnect");
    else if (failure === "timeout") await vi.advanceTimersByTimeAsync(1500);
    else if (failure === "abort") abort.abort();
    else connection.emit(failure, new Error("synthetic"));
    await pending; connection.stream.authorized = true; connection.stream.emit("secureConnect");
    expect(connection.cancel).not.toHaveBeenCalled(); expect(connection.stream.destroy).toHaveBeenCalledOnce();
  });
  it("restricts plaintext to explicit loopback and bounds a nonresponsive cancellation socket", async () => {
    await sendPostgresCancellation({ ...config, tls: { insecureLoopback: true } }, key, new AbortController().signal);
    expect(factory.create).not.toHaveBeenCalled();
    const pending = sendPostgresCancellation({ ...config, host: "127.0.0.1", tls: { insecureLoopback: true } }, key, new AbortController().signal);
    connection.emit("connect"); expect(connection.cancel).toHaveBeenCalledOnce();
    expect(connection.requestSsl).not.toHaveBeenCalled(); await vi.advanceTimersByTimeAsync(1500); await pending;
  });
  it("opens no channel when the query already ended", async () => {
    const abort = new AbortController(); abort.abort(); await sendPostgresCancellation(config, key, abort.signal);
    expect(factory.create).not.toHaveBeenCalled();
  });
});
describe("bounded cancellation polling", () => {
  it("polls serially and delivers once without a terminal assertion", async () => {
    const check = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true), send = vi.fn().mockResolvedValue(undefined);
    const pending = monitorPostgresCancellation(check, send, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(1000); await pending;
    expect(check).toHaveBeenCalledTimes(2); expect(send).toHaveBeenCalledOnce();
  });
  it.each(["timeout", "abort"])("stops on %s without overlapping or delivering a late affirmative result", async mode => {
    let resolve: (value: boolean) => void = () => undefined;
    const check = vi.fn(() => new Promise<boolean>(r => { resolve = r; })), send = vi.fn();
    const abort = new AbortController(); const pending = monitorPostgresCancellation(check, send, abort.signal);
    await vi.advanceTimersByTimeAsync(0);
    if (mode === "abort") abort.abort(); else await vi.advanceTimersByTimeAsync(1000);
    await pending; resolve(true); await vi.advanceTimersByTimeAsync(10000);
    expect(check).toHaveBeenCalledOnce(); expect(send).not.toHaveBeenCalled();
  });
  it("stops cleanly after storage failure or query completion between polls", async () => {
    const send = vi.fn(); await monitorPostgresCancellation(async () => { throw new Error("synthetic"); }, send, new AbortController().signal);
    const abort = new AbortController(), check = vi.fn().mockResolvedValue(false);
    const pending = monitorPostgresCancellation(check, send, abort.signal);
    await vi.advanceTimersByTimeAsync(0); abort.abort(); await pending;
    expect(check).toHaveBeenCalledOnce(); expect(send).not.toHaveBeenCalled();
  });
});
