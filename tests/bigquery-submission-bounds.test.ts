import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchBigQueryMetricRead } from "../lib/bigquery-governed-transport";
import { intentJobIdentity } from "../lib/bigquery-job-identity";
import type { D1Database } from "../lib/d1";

// Isolate response handling. The real claim/replay boundary is exercised by
// bigquery-job-storage.test.ts; native transport has its own Miniflare suite.
vi.mock("../lib/dispatch-authority", () => ({
  async dispatchPreparedMetricRead(_access: unknown, _id: unknown, _subject: unknown, _action: unknown,
    adapter: { prepareRead(job: unknown): Promise<() => Promise<unknown>> }) {
    return (await adapter.prepareRead(submission))();
  }
}));

const limit = 256 * 1024;
let identity: Awaited<ReturnType<typeof intentJobIdentity>>;
let submission: unknown;
let payload: string;
const sendOnce = vi.fn<(request: Request) => Promise<Response>>();
const access = { db: {} as D1Database, tenantId: "fixture", principalId: "owner" };
const dispatch = () => dispatchBigQueryMetricRead(access, "intent", { principalId: "reader", agentId: "agent" },
  { target: "fixture", metricId: "metric", parameters: {} }, {
    projectId: "fixture-project", location: "US", maxBytesBilled: 128,
    loadDefinition: async () => "unused", getAccessToken: async () => "synthetic-token", sendOnce
  });
const uncertain = () => ({ state: "observation-required", jobReference: identity.jobReference });

beforeAll(async () => {
  identity = await intentJobIdentity({ tenantId: "fixture", intentId: "intent", actionDigest: "digest",
    projectId: "fixture-project", location: "US" });
  submission = { identity, queryConfig: { query: "SELECT @p0", maximumBytesBilled: "128", useLegacySql: false } };
  payload = JSON.stringify({ jobReference: identity.jobReference,
    configuration: { jobType: "QUERY", labels: identity.labels, query: { maximumBytesBilled: "128" } } });
});
beforeEach(() => { sendOnce.mockReset(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("bounded governed submission acknowledgment", () => {
  it("accepts exactly the byte ceiling and clears the deadline", async () => {
    vi.useFakeTimers();
    sendOnce.mockResolvedValue(new Response(" ".repeat(limit - payload.length) + payload));
    expect(await dispatch()).toEqual({ state: "accepted", jobReference: identity.jobReference });
    expect(sendOnce).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([undefined, "1", "invalid"])("counts actual bytes with Content-Length %s", async length => {
    const response = new Response(" ".repeat(limit + 1 - payload.length) + payload,
      { headers: length ? { "Content-Length": length } : {} });
    sendOnce.mockResolvedValue(response);
    expect(await dispatch()).toEqual(uncertain());
    expect(sendOnce).toHaveBeenCalledOnce();
    expect(response.body!.locked).toBe(false);
  });

  it("cancels declared excess before acquiring a reader", async () => {
    const response = new Response(payload, { headers: { "Content-Length": String(limit + 1) } });
    const reader = vi.spyOn(response.body!, "getReader"), cancel = vi.spyOn(response.body!, "cancel");
    sendOnce.mockResolvedValue(response);
    expect(await dispatch()).toEqual(uncertain());
    expect(reader).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("counts UTF-8 bytes in unrequested fields", async () => {
    const body = payload.slice(0, -1) + ',"note":"' + "\u00e9".repeat(limit / 2) + '"}';
    expect(body.length).toBeLessThan(limit);
    sendOnce.mockResolvedValue(new Response(body));
    expect(await dispatch()).toEqual(uncertain());
  });

  it("rejects invalid UTF-8 even in an unused field", async () => {
    const encoder = new TextEncoder(), prefix = encoder.encode(payload.slice(0, -1) + ',"note":"');
    const suffix = encoder.encode('"}'), bytes = new Uint8Array(prefix.length + suffix.length + 1);
    bytes.set(prefix); bytes[prefix.length] = 0xff; bytes.set(suffix, prefix.length + 1);
    sendOnce.mockResolvedValue(new Response(bytes));
    expect(await dispatch()).toEqual(uncertain());
  });

  it.each([301, 409, 503])("discards HTTP %s without waiting for cancellation", async status => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const response = new Response(new ReadableStream({ cancel }), { status });
    const reader = vi.spyOn(response.body!, "getReader");
    sendOnce.mockResolvedValue(response);
    expect(await dispatch()).toEqual(uncertain());
    expect(reader).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    expect(sendOnce).toHaveBeenCalledOnce();
  });

  it("discards an already-followed success", async () => {
    const response = new Response(payload);
    Object.defineProperty(response, "redirected", { value: true });
    const cancel = vi.spyOn(response.body!, "cancel");
    sendOnce.mockResolvedValue(response);
    expect(await dispatch()).toEqual(uncertain());
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("bounds stalled headers and cancels a late success without another send", async () => {
    vi.useFakeTimers();
    let arrive!: (response: Response) => void, settled = false;
    sendOnce.mockImplementation(() => new Promise(resolve => { arrive = resolve; }));
    const pending = dispatch().then(result => { settled = true; return result; });
    const response = new Response(payload);
    const reader = vi.spyOn(response.body!, "getReader"), cancel = vi.spyOn(response.body!, "cancel");
    try {
      await vi.advanceTimersByTimeAsync(15_000);
      expect(settled).toBe(true);
      expect(await pending).toEqual(uncertain());
      expect(sendOnce.mock.calls[0][0].signal.aborted).toBe(true);
      arrive(response);
      await vi.advanceTimersByTimeAsync(0);
      expect(reader).not.toHaveBeenCalled();
      expect(cancel).toHaveBeenCalledOnce();
      expect(sendOnce).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally { arrive(response); await pending; }
  });

  it("uses one deadline across headers and a stalled body", async () => {
    vi.useFakeTimers();
    let stream!: ReadableStreamDefaultController<Uint8Array>, settled = false;
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const body = new ReadableStream<Uint8Array>({ start(controller) { stream = controller; }, cancel });
    sendOnce.mockImplementation(() => new Promise(resolve => {
      setTimeout(() => resolve(new Response(body)), 10_000);
    }));
    const pending = dispatch().then(result => { settled = true; return result; });
    try {
      await vi.advanceTimersByTimeAsync(14_000);
      stream.enqueue(new TextEncoder().encode(" "));
      await vi.advanceTimersByTimeAsync(1_000);
      expect(settled).toBe(true);
      expect(await pending).toEqual(uncertain());
      expect(cancel).toHaveBeenCalledOnce();
      expect(body.locked).toBe(false);
      expect(sendOnce).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally { stream.error(new Error("fixture cleanup")); await pending; }
  });

  it.each([null, false, [], "synthetic"])("treats non-object metadata %j as uncertain", async value => {
    sendOnce.mockResolvedValue(Response.json(value));
    expect(await dispatch()).toEqual(uncertain());
  });
});
