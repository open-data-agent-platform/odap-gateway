import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalControlJson, sha256Text } from "../lib/control-objects";
import { settledEvidenceMaxBytes } from "../lib/settled-evidence";
import { inspectSettledEvidence, settledEnvelopeMaxBytes, settledEvidenceFile } from "../lib/settled-evidence-inspection";
import { settledInspectionFixture } from "./fixtures/settled-inspection";

const signal = () => new AbortController().signal;
const get = (body: unknown, status = 200) => vi.fn<typeof fetch>().mockResolvedValue(Response.json(body, { status }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("owner settled evidence inspection", () => {
  it.each([["succeeded", 0], ["failed", 12], ["cancelled", 125]] as const)("checks %s and %i without reformatting the export", async (outcome, amount) => {
    const { body } = await settledInspectionFixture(outcome, amount), read = get(body), abort = signal();
    const result = await inspectSettledEvidence("t", "i", abort, read);
    expect(result).toEqual({ state: "ready", report: { tenantId: "t", intentId: "i", audience: body.evidence.audience,
      json: body.evidence.json, digest: body.evidence.digest, receiptId: JSON.parse(body.evidence.json).final.id, outcome, actualMicroUsd: amount } });
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith("/api/control/t/settled-evidence/i", {
      method: "GET", credentials: "same-origin", cache: "no-store", redirect: "error", signal: abort
    });
    if (result.state !== "ready") throw new Error("Missing report");
    const file = settledEvidenceFile(result.report, "json"), checksum = settledEvidenceFile(result.report, "digest");
    expect(file.content).toBe(body.evidence.json); expect(checksum.content).toBe(body.evidence.digest+"\n");
    expect(file.name).toBe("settled-evidence-"+body.evidence.digest.slice(7)+".json");
    expect(checksum.name).toBe(file.name.replace(/\.json$/, ".sha256")); expect(file.name.length).toBeLessThan(128);
  });
  it("uses the configured mount prefix", async () => {
    vi.stubEnv("NEXT_PUBLIC_GATEWAY_BASE_PATH", "/gateway"); const read = get((await settledInspectionFixture()).body);
    expect((await inspectSettledEvidence("t", "i", signal(), read)).state).toBe("ready");
    expect(read.mock.calls[0][0]).toBe("/gateway/api/control/t/settled-evidence/i");
  });
  it.each(["", "bad!", "a/b", "a%2Fb", " a", "a ", "x".repeat(129)])("rejects invalid scope %# before requesting data", async value => {
    const read = get({}); expect(await inspectSettledEvidence(value, "i", signal(), read)).toEqual({ state: "invalid" });
    expect(await inspectSettledEvidence("t", value, signal(), read)).toEqual({ state: "invalid" }); expect(read).not.toHaveBeenCalled();
  });
  it.each([[401, "unauthenticated"], [403, "denied"], [404, "unavailable"], [405, "unavailable"], [500, "unavailable"], [302, "unavailable"]] as const)
    ("maps HTTP %i to %s without exposing response details", async (status, state) =>
      expect(await inspectSettledEvidence("t", "i", signal(), get({ private: "detail" }, status))).toEqual({ state }));
  it.each([["delegation_not_configured", "incompatible"], ["control_storage_unavailable", "unavailable"], ["unknown", "unavailable"]] as const)
    ("handles %s without a false empty report", async (code, state) =>
      expect(await inspectSettledEvidence("t", "i", signal(), get({ ok: false, code }, 503))).toEqual({ state }));
  it.each(["tenantId", "intentId", "audience", "json", "digest", "source", "issuerAuthenticated", "providerContacted", "executionAuthorized", "settlementAuthorized"])
    ("withholds an absent or changed %s", async field => {
      for (const mode of ["missing", "changed"]) {
        const { body } = await settledInspectionFixture(), record: Record<string, unknown> = body.evidence;
        if (mode === "missing") delete record[field]; else record[field] = typeof record[field] === "boolean" ? true : "changed";
        expect(await inspectSettledEvidence("t", "i", signal(), get(body))).toEqual({ state: "unavailable" });
      }
    });
  it.each([null, [], {}, { ok: true }, { ok: false, evidence: {} }])("rejects malformed envelope %#", async body =>
    expect(await inspectSettledEvidence("t", "i", signal(), get(body))).toEqual({ state: "unavailable" }));
  it("rejects extra envelope and evidence properties", async () => {
    const { body } = await settledInspectionFixture();
    for (const changed of [{ ...body, extra: true }, { ...body, evidence: { ...body.evidence, extra: true } }])
      expect(await inspectSettledEvidence("t", "i", signal(), get(changed))).toEqual({ state: "unavailable" });
  });
  it.each(["scope", "audience", "receipt", "bill", "chronology", "noncanonical"])("rejects %s damage even with a new checksum", async kind => {
    const { data, body } = await settledInspectionFixture();
    if (kind === "scope") data.intent.tenantId = "other";
    if (kind === "audience") data.delegation.billedAudience = "other";
    if (kind === "receipt") data.final.id = "wrong";
    if (kind === "bill") data.bill.actualMicroUsd++;
    if (kind === "chronology") data.job.claimedAt = "2099-01-01T00:00:00.000Z";
    body.evidence.json = kind === "noncanonical" ? JSON.stringify(data, null, 2) : canonicalControlJson(data);
    body.evidence.digest = await sha256Text(body.evidence.json);
    expect(await inspectSettledEvidence("t", "i", signal(), get(body))).toEqual({ state: "unavailable" });
  });
  it("rejects a checksum mismatch and a legacy non-delegated profile", async () => {
    const { data, body } = await settledInspectionFixture(); body.evidence.digest = "sha256:"+"0".repeat(64);
    expect(await inspectSettledEvidence("t", "i", signal(), get(body))).toEqual({ state: "unavailable" });
    const { delegation: _delegation, ...legacy } = data; void _delegation;
    legacy.profile = "odap.gateway.local.settled-bigquery.v1"; body.evidence.json = canonicalControlJson(legacy); body.evidence.digest = await sha256Text(body.evidence.json);
    expect(await inspectSettledEvidence("t", "i", signal(), get(body))).toEqual({ state: "unavailable" });
  });
  it("refuses malformed and oversized streams, including misleading content length", async () => {
    const { body } = await settledInspectionFixture();
    body.evidence.json = "x".repeat(settledEvidenceMaxBytes+1);
    expect(await inspectSettledEvidence("t", "i", signal(), get(body))).toEqual({ state: "unavailable" });
    for (const announced of ["1", String(settledEnvelopeMaxBytes+1)]) {
      const cancel = vi.fn(), stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(settledEnvelopeMaxBytes+1)); }, cancel });
      const read = vi.fn<typeof fetch>().mockResolvedValue(new Response(stream, { headers: { "Content-Length": announced } }));
      expect(await inspectSettledEvidence("t", "i", signal(), read)).toEqual({ state: "unavailable" }); expect(cancel).toHaveBeenCalledTimes(1);
    }
    const read = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array([0xff])));
    expect(await inspectSettledEvidence("t", "i", signal(), read)).toEqual({ state: "unavailable" });
  });
  it("cancels a stalled response when the visible lookup is aborted", async () => {
    const abort = new AbortController(), cancel = vi.fn();
    const read = vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({ cancel })));
    const pending = inspectSettledEvidence("t", "i", abort.signal, read); await Promise.resolve(); abort.abort();
    expect(await pending).toEqual({ state: "unavailable" }); expect(cancel).toHaveBeenCalledTimes(1);
  });
  it("bounds the whole body read even if stream cancellation stalls", async () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn(() => new Promise<void>(() => {}));
      const read = vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({ cancel })));
      const pending = inspectSettledEvidence("t", "i", signal(), read);
      await vi.advanceTimersByTimeAsync(15000);
      expect(await pending).toEqual({ state: "unavailable" }); expect(cancel).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
  it("accepts the exact evidence byte bound with escaped text and refuses an unsafe filename", async () => {
    const { data, body } = await settledInspectionFixture(); data.final.reason = "";
    const remaining = settledEvidenceMaxBytes - new TextEncoder().encode(canonicalControlJson(data)).byteLength;
    data.final.reason = '"'.repeat(Math.floor(remaining / 2)) + "x".repeat(remaining % 2);
    body.evidence.json = canonicalControlJson(data); body.evidence.digest = await sha256Text(body.evidence.json);
    expect(new TextEncoder().encode(body.evidence.json).byteLength).toBe(settledEvidenceMaxBytes);
    const result = await inspectSettledEvidence("t", "i", signal(), get(body));
    expect(result.state).toBe("ready");
    if (result.state !== "ready") throw new Error("Missing report");
    expect(() => settledEvidenceFile({ ...result.report, digest: "../other" }, "json")).toThrow("Invalid evidence checksum");
  });
  it("rejects network failure and does not return ready after abort during checksum verification", async () => {
    expect(await inspectSettledEvidence("t", "i", signal(), vi.fn<typeof fetch>().mockRejectedValue(new Error("private network detail"))))
      .toEqual({ state: "unavailable" });
    const abort = new AbortController(), { body } = await settledInspectionFixture(), digest = crypto.subtle.digest.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "digest").mockImplementation(async (...args) => { abort.abort(); return digest(...args); });
    expect(await inspectSettledEvidence("t", "i", abort.signal, get(body))).toEqual({ state: "unavailable" });
  });
});
