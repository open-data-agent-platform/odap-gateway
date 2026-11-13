import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalControlJson, sha256Text } from "../lib/control-objects";
import { cancellationEvidenceMaxBytes } from "../lib/cancellation-evidence";
import { inspectCancellationEvidence, cancellationEnvelopeMaxBytes, cancellationEvidenceFile } from "../lib/cancellation-evidence-inspection";
import { cancellationInspectionFixture } from "./fixtures/cancellation-inspection";

const signal = () => new AbortController().signal;
const get = (body: unknown, status = 200) => vi.fn<typeof fetch>().mockResolvedValue(Response.json(body, { status }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("owner cancellation request evidence inspection", () => {
  it("verifies request provenance without reformatting or inferring cancellation", async () => {
    const { data, body } = await cancellationInspectionFixture(), read = get(body), abort = signal();
    const result = await inspectCancellationEvidence("t", "i", abort, read);
    expect(result).toEqual({ state: "ready", report: { tenantId: "t", intentId: "i", audience: data.audience,
      json: body.evidence.json, digest: body.evidence.digest, jobId: data.job.jobId, pendingReceiptId: data.job.pendingReceiptId,
      requestedBy: data.request.requestedBy, requestedAt: data.request.requestedAt } });
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith("/api/control/t/cancellation-evidence/i", {
      method: "GET", credentials: "same-origin", cache: "no-store", redirect: "error", signal: abort
    });
    if (result.state !== "ready") throw new Error("Missing report");
    expect(result.report).not.toHaveProperty("outcome"); expect(result.report).not.toHaveProperty("actualMicroUsd");
    const file = cancellationEvidenceFile(result.report, "json"), checksum = cancellationEvidenceFile(result.report, "digest");
    expect(file.content).toBe(body.evidence.json); expect(checksum.content).toBe(body.evidence.digest+"\n");
    expect(file.name).toBe("cancellation-request-"+body.evidence.digest.slice(7)+".json");
    expect(checksum.name).toBe(file.name.replace(/\.json$/, ".sha256")); expect(file.name.length).toBeLessThan(128);
  });
  it("uses the configured mount prefix", async () => {
    vi.stubEnv("NEXT_PUBLIC_GATEWAY_BASE_PATH", "/gateway"); const read = get((await cancellationInspectionFixture()).body);
    expect((await inspectCancellationEvidence("t", "i", signal(), read)).state).toBe("ready");
    expect(read.mock.calls[0][0]).toBe("/gateway/api/control/t/cancellation-evidence/i");
  });
  it.each(["", "bad!", "a/b", "a%2Fb", " a", "a ", "x".repeat(129)])("rejects invalid scope %# before requesting data", async value => {
    const read = get({}); expect(await inspectCancellationEvidence(value, "i", signal(), read)).toEqual({ state: "invalid" });
    expect(await inspectCancellationEvidence("t", value, signal(), read)).toEqual({ state: "invalid" }); expect(read).not.toHaveBeenCalled();
  });
  it.each([[401, "unauthenticated"], [403, "denied"], [404, "unavailable"], [405, "unavailable"], [500, "unavailable"], [302, "unavailable"]] as const)
    ("maps HTTP %i to %s without exposing response details", async (status, state) =>
      expect(await inspectCancellationEvidence("t", "i", signal(), get({ private: "detail" }, status))).toEqual({ state }));
  it.each([["delegation_not_configured", "incompatible"], ["control_storage_unavailable", "unavailable"], ["unknown", "unavailable"]] as const)
    ("handles %s without a false empty report", async (code, state) =>
      expect(await inspectCancellationEvidence("t", "i", signal(), get({ ok: false, code }, 503))).toEqual({ state }));
  it.each(["tenantId", "intentId", "audience", "json", "digest", "scope", "source", "issuerAuthenticated",
    "cancellationConfirmed", "providerContacted", "cancellationAuthorized", "executionAuthorized", "settlementAuthorized"])
    ("withholds an absent or changed %s", async field => {
      for (const mode of ["missing", "changed"]) {
        const { body } = await cancellationInspectionFixture(), record: Record<string, unknown> = body.evidence;
        if (mode === "missing") delete record[field]; else record[field] = typeof record[field] === "boolean" ? true : "changed";
        expect(await inspectCancellationEvidence("t", "i", signal(), get(body))).toEqual({ state: "unavailable" });
      }
    });
  it.each([null, [], {}, { ok: true }, { ok: false, evidence: {} }])("rejects malformed envelope %#", async body =>
    expect(await inspectCancellationEvidence("t", "i", signal(), get(body))).toEqual({ state: "unavailable" }));
  it("rejects extra envelope and evidence properties", async () => {
    const { body } = await cancellationInspectionFixture();
    for (const changed of [{ ...body, extra: true }, { ...body, evidence: { ...body.evidence, outcome: "cancelled" } }])
      expect(await inspectCancellationEvidence("t", "i", signal(), get(changed))).toEqual({ state: "unavailable" });
  });
  it.each(["scope", "audience", "job", "claim", "chronology", "profile", "noncanonical", "outcome"])
    ("rejects %s damage even with a new checksum", async kind => {
      const { data, body } = await cancellationInspectionFixture();
      if (kind === "scope") data.tenantId = "other";
      if (kind === "audience") data.request.audience = "other";
      if (kind === "job") data.job.jobId = "wrong";
      if (kind === "claim") data.request.claimBodyDigest = "sha256:"+"0".repeat(64);
      if (kind === "chronology") data.request.requestedAt = "2000-01-01T00:00:00.000Z";
      if (kind === "profile") data.profile = "odap.gateway.local.settled-bigquery.v1";
      if (kind === "outcome") Object.assign(data, { outcome: "cancelled" });
      body.evidence.json = kind === "noncanonical" ? JSON.stringify(data, null, 2) : canonicalControlJson(data);
      body.evidence.digest = await sha256Text(body.evidence.json);
      expect(await inspectCancellationEvidence("t", "i", signal(), get(body))).toEqual({ state: "unavailable" });
    });
  it("rejects checksum mismatch and a claimed terminal evidence scope", async () => {
    const { body } = await cancellationInspectionFixture(); body.evidence.digest = "sha256:"+"0".repeat(64);
    expect(await inspectCancellationEvidence("t", "i", signal(), get(body))).toEqual({ state: "unavailable" });
    const next = (await cancellationInspectionFixture()).body; next.evidence.scope = "confirmed-cancellation";
    expect(await inspectCancellationEvidence("t", "i", signal(), get(next))).toEqual({ state: "unavailable" });
  });
  it("refuses malformed and oversized streams, including misleading content length", async () => {
    const { body } = await cancellationInspectionFixture(); body.evidence.json = "x".repeat(cancellationEvidenceMaxBytes+1);
    expect(await inspectCancellationEvidence("t", "i", signal(), get(body))).toEqual({ state: "unavailable" });
    for (const announced of ["1", String(cancellationEnvelopeMaxBytes+1)]) {
      const cancel = vi.fn(), stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(cancellationEnvelopeMaxBytes+1)); }, cancel });
      const read = vi.fn<typeof fetch>().mockResolvedValue(new Response(stream, { headers: { "Content-Length": announced } }));
      expect(await inspectCancellationEvidence("t", "i", signal(), read)).toEqual({ state: "unavailable" }); expect(cancel).toHaveBeenCalledTimes(1);
    }
    const read = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array([0xff])));
    expect(await inspectCancellationEvidence("t", "i", signal(), read)).toEqual({ state: "unavailable" });
  });
  it("cancels a stalled response when the visible lookup is aborted", async () => {
    const abort = new AbortController(), cancel = vi.fn();
    const read = vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({ cancel })));
    const pending = inspectCancellationEvidence("t", "i", abort.signal, read); await Promise.resolve(); abort.abort();
    expect(await pending).toEqual({ state: "unavailable" }); expect(cancel).toHaveBeenCalledTimes(1);
  });
  it("bounds the whole body read even if stream cancellation stalls", async () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn(() => new Promise<void>(() => {}));
      const read = vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({ cancel })));
      const pending = inspectCancellationEvidence("t", "i", signal(), read);
      await vi.advanceTimersByTimeAsync(15000);
      expect(await pending).toEqual({ state: "unavailable" }); expect(cancel).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
  it("preserves escaped multibyte request text and refuses unsafe filenames", async () => {
    const { data, body } = await cancellationInspectionFixture(); data.request.requestedBy = "\u{1f9ea}".repeat(500)+'"\\';
    body.evidence.json = canonicalControlJson(data); body.evidence.digest = await sha256Text(body.evidence.json);
    const result = await inspectCancellationEvidence("t", "i", signal(), get(body)); expect(result.state).toBe("ready");
    if (result.state !== "ready") throw new Error("Missing report");
    expect(result.report.requestedBy).toBe(data.request.requestedBy);
    expect(cancellationEvidenceFile(result.report, "json").content).toBe(body.evidence.json);
    expect(() => cancellationEvidenceFile({ ...result.report, digest: "../other" }, "json")).toThrow("Invalid evidence checksum");
  });
  it("rejects network failure and does not return ready after abort during checksum verification", async () => {
    expect(await inspectCancellationEvidence("t", "i", signal(), vi.fn<typeof fetch>().mockRejectedValue(new Error("private network detail"))))
      .toEqual({ state: "unavailable" });
    const abort = new AbortController(), { body } = await cancellationInspectionFixture(), digest = crypto.subtle.digest.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "digest").mockImplementation(async (...args) => { abort.abort(); return digest(...args); });
    expect(await inspectCancellationEvidence("t", "i", abort.signal, get(body))).toEqual({ state: "unavailable" });
  });
});
