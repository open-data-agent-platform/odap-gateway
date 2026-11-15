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
    expect(await pending).toBe("write-attempted"); expect(connection.stream.destroy).toHaveBeenCalledOnce();
  });
  it.each(["error", "errorMessage", "untrusted", "timeout", "abort"])("does not send on %s or late TLS callbacks", async failure => {
    const abort = new AbortController(); const pending = sendPostgresCancellation(config, key, abort.signal);
    connection.emit("connect"); connection.emit("sslconnect");
    if (failure === "untrusted") connection.stream.emit("secureConnect");
    else if (failure === "timeout") await vi.advanceTimersByTimeAsync(1500);
    else if (failure === "abort") abort.abort();
    else connection.emit(failure, new Error("synthetic"));
    expect(await pending).toBe(failure === "abort" ? "stopped" : "not-sent");
    connection.stream.authorized = true; connection.stream.emit("secureConnect");
    expect(connection.cancel).not.toHaveBeenCalled(); expect(connection.stream.destroy).toHaveBeenCalledOnce();
  });
  it("restricts plaintext to explicit loopback and bounds a nonresponsive cancellation socket", async () => {
    expect(await sendPostgresCancellation({ ...config, tls: { insecureLoopback: true } }, key, new AbortController().signal)).toBe("stopped");
    expect(factory.create).not.toHaveBeenCalled();
    const pending = sendPostgresCancellation({ ...config, host: "127.0.0.1", tls: { insecureLoopback: true } }, key, new AbortController().signal);
    connection.emit("connect"); expect(connection.cancel).toHaveBeenCalledOnce();
    expect(connection.requestSsl).not.toHaveBeenCalled(); await vi.advanceTimersByTimeAsync(1500);
    expect(await pending).toBe("write-attempted");
  });
  it("opens no channel when the query already ended", async () => {
    const abort = new AbortController(); abort.abort();
    expect(await sendPostgresCancellation(config, key, abort.signal)).toBe("stopped");
    expect(factory.create).not.toHaveBeenCalled();
  });
  it("does not classify a throwing write as safely retryable", async () => {
    connection.cancel.mockImplementation(() => { throw new Error("synthetic partial write"); });
    const pending = sendPostgresCancellation(config, key, new AbortController().signal);
    connection.emit("connect"); connection.emit("sslconnect");
    connection.stream.authorized = true; connection.stream.emit("secureConnect");
    expect(await pending).toBe("write-attempted");
    expect(connection.cancel).toHaveBeenCalledOnce();
  });
  it("classifies a channel deadline before TLS as not sent", async () => {
    const pending = sendPostgresCancellation(config, key, new AbortController().signal);
    connection.emit("connect"); connection.emit("sslconnect");
    await vi.advanceTimersByTimeAsync(1500);
    expect(await pending).toBe("not-sent"); expect(connection.cancel).not.toHaveBeenCalled();
  });
});
describe("bounded cancellation polling", () => {
  it("polls serially and delivers once without a terminal assertion", async () => {
    const check = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true), send = vi.fn().mockResolvedValue("write-attempted");
    const pending = monitorPostgresCancellation(check, send, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(1000); await pending;
    expect(check).toHaveBeenCalledTimes(2); expect(send).toHaveBeenCalledOnce();
  });
  it("rechecks intent and retries a failed pre-write channel with bounded spacing", async () => {
    const check = vi.fn().mockResolvedValue(true);
    const send = vi.fn().mockResolvedValueOnce("not-sent").mockResolvedValue("write-attempted");
    const pending = monitorPostgresCancellation(check, send, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(999); expect(send).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1); await pending;
    expect(check).toHaveBeenCalledTimes(2); expect(send).toHaveBeenCalledTimes(2);
  });
  it("stops after three pre-write failures without inferring a terminal result", async () => {
    const check = vi.fn().mockResolvedValue(true), send = vi.fn().mockResolvedValue("not-sent");
    const pending = monitorPostgresCancellation(check, send, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(2000); expect(await pending).toBeUndefined();
    expect(check).toHaveBeenCalledTimes(3); expect(send).toHaveBeenCalledTimes(3);
  });
  it.each(["write-attempted", "stopped"])("does not retry a %s delivery", async delivery => {
    const check = vi.fn().mockResolvedValue(true), send = vi.fn().mockResolvedValue(delivery);
    await monitorPostgresCancellation(check, send, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(10000);
    expect(check).toHaveBeenCalledOnce(); expect(send).toHaveBeenCalledOnce();
  });
  it("stops a pending retry as soon as the original query ends", async () => {
    const abort = new AbortController(), check = vi.fn().mockResolvedValue(true), send = vi.fn().mockResolvedValue("not-sent");
    const pending = monitorPostgresCancellation(check, send, abort.signal);
    await vi.advanceTimersByTimeAsync(0); abort.abort(); await pending;
    await vi.advanceTimersByTimeAsync(5000);
    expect(check).toHaveBeenCalledOnce(); expect(send).toHaveBeenCalledOnce();
  });
  it("does not retry when a fresh intent check fails", async () => {
    const check = vi.fn().mockResolvedValueOnce(true).mockRejectedValue(new Error("synthetic storage failure"));
    const send = vi.fn().mockResolvedValue("not-sent");
    const pending = monitorPostgresCancellation(check, send, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(1000); await pending;
    expect(check).toHaveBeenCalledTimes(2); expect(send).toHaveBeenCalledOnce();
  });
  it("awaits each channel before opening another", async () => {
    const abort = new AbortController(), check = vi.fn().mockResolvedValue(true);
    let finish: (value: "stopped") => void = () => undefined;
    const send = vi.fn(() => new Promise<"stopped">(resolve => { finish = resolve; }));
    const pending = monitorPostgresCancellation(check, send, abort.signal);
    await vi.advanceTimersByTimeAsync(10000);
    expect(check).toHaveBeenCalledOnce(); expect(send).toHaveBeenCalledOnce();
    abort.abort(); finish("stopped"); await pending;
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
