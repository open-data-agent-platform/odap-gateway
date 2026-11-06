import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { intentJobIdentity } from "../lib/bigquery-job-identity";
import { parseJobObservation, readJobObservation } from "../lib/bigquery-job-metadata";

const limit = 256 * 1024;
const failure = "BigQuery job lookup failed";
let identity: Awaited<ReturnType<typeof intentJobIdentity>>;
let payload: string;
beforeAll(async () => {
  identity = await intentJobIdentity({ tenantId: "fixture", intentId: "intent", actionDigest: "digest",
    projectId: "fixture-project", location: "US" });
  payload = JSON.stringify({ jobReference: identity.jobReference,
    configuration: { jobType: "QUERY", labels: identity.labels, query: { maximumBytesBilled: "128" } },
    status: { state: "DONE" }, statistics: { query: { totalBytesBilled: "0" } } });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
const read = (response: Response) => parseJobObservation(response, identity, 128);

describe("bounded BigQuery observation bodies", () => {
  it("accepts the exact response byte ceiling and clears its timer", async () => {
    vi.useFakeTimers();
    expect(await read(new Response(" ".repeat(limit - payload.length) + payload)))
      .toEqual({ state: "succeeded", billedBytes: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([undefined, "1", "invalid"])("counts actual bytes despite Content-Length %s", async length => {
    const body = new Response(" ".repeat(limit + 1 - payload.length) + payload,
      { headers: length ? { "Content-Length": length } : {} });
    await expect(read(body)).rejects.toThrow(failure);
    expect(body.body!.locked).toBe(false);
  });

  it("rejects declared excess without reading the body", async () => {
    const response = new Response(payload, { headers: { "Content-Length": String(limit + 1) } });
    const reader = vi.spyOn(response.body!, "getReader");
    const cancel = vi.spyOn(response.body!, "cancel");
    await expect(read(response)).rejects.toThrow(failure);
    expect(reader).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("counts UTF-8 bytes, including fields outside the requested metadata", async () => {
    const body = payload.slice(0, -1) + ',"note":"' + "\u00e9".repeat(limit / 2) + '"}';
    expect(body.length).toBeLessThan(limit);
    await expect(read(new Response(body))).rejects.toThrow(failure);
  });

  it("rejects invalid UTF-8 even in an unused field", async () => {
    const encoder = new TextEncoder();
    const prefix = encoder.encode(payload.slice(0, -1) + ',"note":"');
    const suffix = encoder.encode('"}');
    const bytes = new Uint8Array(prefix.length + 1 + suffix.length);
    bytes.set(prefix); bytes[prefix.length] = 0xff; bytes.set(suffix, prefix.length + 1);
    await expect(read(new Response(bytes))).rejects.toEqual(new Error(failure));
  });

  it.each([null, "synthetic-private-provider-body", ""])("sanitizes invalid JSON/body %s", async body => {
    await expect(read(new Response(body))).rejects.toEqual(new Error(failure));
  });

  it.each([301, 404, 503])("discards HTTP %s without parsing or waiting for cancellation", async status => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const response = new Response(new ReadableStream({ cancel }), { status });
    const reader = vi.spyOn(response.body!, "getReader");
    if (status === 404) await expect(read(response)).resolves.toEqual({ state: "not-found" });
    else await expect(read(response)).rejects.toThrow(failure);
    expect(reader).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("bounds a stalled body without extending the deadline for another chunk", async () => {
    vi.useFakeTimers();
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const body = new ReadableStream<Uint8Array>({ start(controller) { stream = controller; }, cancel });
    let settled = false;
    const pending = read(new Response(body)).catch(error => { settled = true; return error.message; });
    try {
      await vi.advanceTimersByTimeAsync(14_000);
      stream.enqueue(new TextEncoder().encode(" "));
      await vi.advanceTimersByTimeAsync(1_000);
      expect(settled).toBe(true);
      expect(await pending).toBe(failure);
      expect(cancel).toHaveBeenCalledOnce();
      expect(body.locked).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      stream.error(new Error("fixture cleanup"));
      await pending;
    }
  });

  it("aborts a stalled lookup and discards late successful headers without parsing", async () => {
    vi.useFakeTimers();
    let arrive!: (response: Response) => void;
    const lookup = vi.fn((signal: AbortSignal) => {
      expect(signal.aborted).toBe(false);
      return new Promise<Response>(resolve => { arrive = resolve; });
    });
    const pending = expect(readJobObservation(lookup, identity, 128)).rejects.toThrow(failure);
    await vi.advanceTimersByTimeAsync(15_000);
    await pending;
    expect(lookup).toHaveBeenCalledOnce();
    expect(lookup.mock.calls[0][0].aborted).toBe(true);
    const response = new Response(payload);
    const reader = vi.spyOn(response.body!, "getReader");
    const cancel = vi.spyOn(response.body!, "cancel");
    arrive(response);
    await vi.advanceTimersByTimeAsync(0);
    expect(reader).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("sanitizes transport and stream errors without another lookup", async () => {
    const lookup = vi.fn(async () => { throw new Error("synthetic-private-transport"); });
    await expect(readJobObservation(lookup, identity)).rejects.toEqual(new Error(failure));
    expect(lookup).toHaveBeenCalledOnce();
    const body = new ReadableStream({ start(controller) { controller.error(new Error("synthetic-private-stream")); } });
    await expect(read(new Response(body))).rejects.toEqual(new Error(failure));
    expect(body.locked).toBe(false);
  });

  it.each([200, 404])("rejects already-followed responses before status interpretation: %s", async status => {
    const response = new Response(payload, { status });
    Object.defineProperty(response, "redirected", { value: true });
    const cancel = vi.spyOn(response.body!, "cancel");
    await expect(read(response)).rejects.toThrow("lookup redirected");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([null, false, [], "synthetic"])("rejects non-object metadata %j", async value => {
    await expect(read(Response.json(value))).rejects.toThrow("Unmatched BigQuery job");
  });
});
