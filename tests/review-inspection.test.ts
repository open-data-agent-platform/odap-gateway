import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { inspectRevision, submitApproval, submitPromotion, submitRetirement, submitValidation, submitWithdrawal, type Inspection } from "../lib/review-inspection";

const definitionJson = '{"metricId":"orders","profile":"odap.bigquery-metric.v1","sourceRevision":"s","tenantId":"t"}';
const definitionDigest = "sha256:" + createHash("sha256").update(definitionJson).digest("hex");
const revision = { tenantId: "t", revisionId: "rev", definitionDigest, definitionJson };
const review = { ...revision, state: "approved", metricId: "orders", sourceRevision: "s" };
const definition = { ok: true, revision }, snapshot = { ok: true, review };
const signal = new AbortController().signal;
const inspect = (get: typeof fetch) => inspectRevision("t", "rev", signal, get);

describe("inspection client", () => {
  it("only performs scoped, uncached GETs and preserves the bytes it hashed", async () => {
    const get = vi.fn().mockResolvedValueOnce(Response.json(definition)).mockResolvedValueOnce(Response.json(snapshot));
    expect(await inspect(get)).toMatchObject({ ok: true, value: { state: "approved", definitionJson, definitionDigest } });
    expect(get.mock.calls).toEqual(["definition", "review"].map(kind => ["/api/control/t/" + kind + "/rev",
      { method: "GET", credentials: "same-origin", cache: "no-store", redirect: "error", signal }]));
  });

  it.each(["../other", "x/y", "", "x".repeat(129)])("does not fetch an invalid control path", async id => {
    const get = vi.fn();
    expect(await inspectRevision(id, "rev", signal, get)).toEqual({ ok: false, error: "invalid" });
    expect(await inspectRevision("t", id, signal, get)).toEqual({ ok: false, error: "invalid" });
    expect(get).not.toHaveBeenCalled();
  });

  it.each([{ tenantId: "peer" }, { revisionId: "other" }, { definitionJson: definitionJson + " " }])(
    "refuses substituted definition bytes or identity", async changes => {
      const get = vi.fn().mockResolvedValueOnce(Response.json({ ok: true, revision: { ...revision, ...changes } }));
      expect(await inspect(get)).toEqual({ ok: false, error: "inconsistent" });
      expect(get).toHaveBeenCalledTimes(1);
    });

  it.each([{ tenantId: "peer" }, { revisionId: "other" }, { definitionDigest: "different" }, { state: "ready" },
    { metricId: "another_metric" }, { sourceRevision: "stale" }])("never combines incompatible reads", async changes => {
      const get = vi.fn().mockResolvedValueOnce(Response.json(definition))
        .mockResolvedValueOnce(Response.json({ ok: true, review: { ...review, ...changes } }));
      expect(await inspect(get)).toEqual({ ok: false, error: "inconsistent" });
    });

  it.each([[401, "unauthenticated", "signed_out"], [403, "tenant_access_denied", "forbidden"],
    [404, "not_found", "not_found"], [503, "control_storage_unavailable", "unavailable"]] as const)(
    "discards previously fetched bytes on HTTP %s", async (status, code, error) => {
      const get = vi.fn().mockResolvedValueOnce(Response.json(definition)).mockResolvedValueOnce(Response.json({ ok: false, code }, { status }));
      expect(await inspect(get)).toEqual({ ok: false, error });
    });

  it("fails closed on network and non-JSON responses", async () => {
    expect(await inspect(vi.fn().mockRejectedValue(new Error("private detail")))).toEqual({ ok: false, error: "unavailable" });
    expect(await inspect(vi.fn().mockResolvedValue(new Response("<html/>")))).toEqual({ ok: false, error: "unavailable" });
    expect(await inspect(vi.fn().mockResolvedValue(new Response("<html/>", { status: 404 })))).toEqual({ ok: false, error: "unavailable" });
  });
});

describe("owner approval evidence", () => {
  it.each([{ tenantId: "peer" }, { revisionId: "not-rev" }, { definitionDigest: "other" },
    { evidenceRef: " " }, { evidenceRef: null }])("discards mismatched or incomplete private evidence", async change => {
    const get = vi.fn().mockResolvedValueOnce(Response.json(definition)).mockResolvedValueOnce(Response.json({
      ok: true, review: { ...review, state: "validated", canReviewApproval: true }
    })).mockResolvedValueOnce(Response.json({ ok: true, basis: { ...revision, evidenceRef: "ref", ...change } }));
    expect(await inspect(get)).toEqual({ ok: false, error: "inconsistent" });
    expect(get.mock.calls[2][0]).toBe("/api/control/t/approval-basis/rev");
  });
  it("does not trust evidence injected into a shared summary or a foreign approval confirmation", async () => {
    const get = vi.fn().mockResolvedValueOnce(Response.json(definition)).mockResolvedValueOnce(Response.json({
      ok: true, review: { ...review, state: "validated", approvalEvidence: "injected" }
    }));
    const result = await inspect(get);
    if (!result.ok) throw new Error("Expected a read-only inspection");
    const post = vi.fn();
    expect(await submitApproval(result.value, "decision", signal, post)).toBe("denied");
    expect(post).not.toHaveBeenCalled();
    post.mockResolvedValue(Response.json({ ok: true, approval: { approvalId: "different", revisionId: "rev" } },
      { status: 201, headers: { Location: "/api/control/t/review/rev" } }));
    expect(await submitApproval({ ...result.value, approvalEvidence: "ref" }, "decision", signal, post)).toBe("unknown");
    expect(post).toHaveBeenCalledTimes(1);
  });
});

describe("inspected promotion command", () => {
  const approved: Inspection = { ...review, state: "approved", canRecordValidation: false, approvalId: "a", canRequestPromotion: true, canWithdrawApproval: true, canRetireRelease: false };
  it("sends only the three identifiers and requires a scoped created-release confirmation", async () => {
    const post = vi.fn().mockResolvedValue(Response.json({ ok: true, promotion: { releaseId: "new" } },
      { status: 201, headers: { Location: "/api/control/t/release/new" } }));
    expect(await submitPromotion(approved, "new", signal, post)).toBe("published");
    const [url, init] = post.mock.calls[0];
    expect(url).toBe("/api/control/t/promotions");
    expect(JSON.parse(init.body)).toEqual({ revisionId: "rev", approvalId: "a", releaseId: "new" });
  });
  it.each([{ canRequestPromotion: false }, { state: "withdrawn" }, { state: "validated" },
    { approvalId: undefined }, { approvalId: "bad/id" }, { releaseId: "already" }] as const)(
    "does not derive publication authority from a state label alone", async changes => {
      const post = vi.fn();
      expect(await submitPromotion({ ...approved, ...changes }, "new", signal, post)).toBe("denied");
      expect(post).not.toHaveBeenCalled();
    });
  it.each([[200, "new", "/api/control/t/release/new"], [201, "other", "/api/control/t/release/new"],
    [201, "new", "/api/control/peer/release/new"]] as const)("does not acknowledge a mismatched response", async (status, id, location) => {
    const post = vi.fn().mockResolvedValue(Response.json({ ok: true, promotion: { releaseId: id } }, { status, headers: { Location: location } }));
    expect(await submitPromotion(approved, "new", signal, post)).toBe("unknown");
    expect(post).toHaveBeenCalledTimes(1);
  });
  it.each([{ state: "retired", releaseId: "../escape" }, { state: "published", releaseId: null },
    { state: "approved", releaseId: "invented" }])("refuses inconsistent release identity on readback", async changes => {
    const get = vi.fn().mockResolvedValueOnce(Response.json(definition)).mockResolvedValueOnce(Response.json({
      ok: true, review: { ...review, approvalId: "a", ...changes }
    }));
    expect(await inspect(get)).toEqual({ ok: false, error: "inconsistent" });
  });
});

describe("inspected release retirement", () => {
  const published: Inspection = { ...review, state: "published", approvalId: "a", releaseId: "rel", canRetireRelease: true,
    canRequestPromotion: false, canWithdrawApproval: false, canRecordValidation: false };
  const at = "2026-11-05T12:30:00.123Z", effect = "future_dispatch_claims_only", location = "/api/control/t/release/rel";
  it.each([[201, "retired", at, "retired"], [200, "already_retired", at, "alreadyRetired"],
    [200, "legacy_retired", undefined, "legacyRetired"]] as const)("accepts scoped %s %s", async (status, tag, retiredAt, kind) => {
    const post = vi.fn().mockResolvedValue(Response.json({ ok: true, effect, retirement: { status: tag, retiredAt } },
      { status, headers: { Location: location } }));
    expect(await submitRetirement(published, "why", signal, post)).toEqual({ kind, releaseId: "rel", retiredAt: retiredAt ?? null });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]).toMatchObject(["/api/control/t/retirements", { method: "POST", credentials: "same-origin",
      body: JSON.stringify({ releaseId: "rel", reason: "why" }) }]);
  });
  it.each([[200, "retired", at, effect, location], [201, "retired", "bad", effect, location],
    [201, "retired", at, "cancelled", location], [201, "retired", at, effect, "/api/control/peer/release/rel"],
    [201, "retired", at, effect, "/api/control/t/release/other"], [200, "legacy_retired", at, effect, location]] as const)(
    "does not confirm a mismatched response", async (status, tag, retiredAt, effect, location) => {
      const post = vi.fn().mockResolvedValue(Response.json({ ok: true, effect, retirement: { status: tag, retiredAt } },
        { status, headers: { Location: location } }));
      expect(await submitRetirement(published, "why", signal, post)).toEqual({ kind: "unknown" });
      expect(post).toHaveBeenCalledTimes(1);
    });
  it("rejects stale hints, unsafe paths and invalid reasons before posting", async () => {
    const post = vi.fn();
    for (const fields of [{ canRetireRelease: false }, { state: "retired" }, { releaseId: "../x" }, { releaseId: undefined }] as const)
      expect(await submitRetirement({ ...published, ...fields }, "why", signal, post)).toEqual({ kind: "denied" });
    for (const reason of ["", " ", " why", "a\0b", "x".repeat(1025)])
      expect(await submitRetirement(published, reason, signal, post)).toEqual({ kind: "invalidReason" });
    expect(post).not.toHaveBeenCalled();
  });
  it.each([{ state: "retired" }, { state: "retired", retiredAt: "bad" }, { state: "published", retiredAt: at }])(
    "distinguishes an explicit legacy null from missing or contradictory data", async fields => {
      const get = vi.fn().mockResolvedValueOnce(Response.json(definition)).mockResolvedValueOnce(Response.json({
        ok: true, review: { ...published, ...fields }
      }));
      expect(await inspect(get)).toEqual({ ok: false, error: "inconsistent" });
    });
});

describe("inspected withdrawal command", () => {
  const approved: Inspection = { ...review, state: "approved", approvalId: "a", canRecordValidation: false,
    canRequestPromotion: false, canWithdrawApproval: true, canRetireRelease: false };
  const time = "2026-11-05T12:30:00.123Z";
  const location = "/api/control/t/review/rev";
  it.each([{ state: "withdrawn" }, { state: "withdrawn", withdrawnAt: "not-a-date" },
    { state: "withdrawn", approvalId: null, withdrawnAt: time }, { state: "approved", withdrawnAt: time }])(
    "rejects a withdrawal timestamp inconsistent with the approval snapshot", async fields => {
      const get = vi.fn().mockResolvedValueOnce(Response.json(definition)).mockResolvedValueOnce(Response.json({
        ok: true, review: { ...review, approvalId: "a", ...fields }
      }));
      expect(await inspect(get)).toEqual({ ok: false, error: "inconsistent" });
    });
  it.each([[201, "withdrawn", "withdrawn"], [200, "already_withdrawn", "alreadyWithdrawn"]] as const)(
    "matches the scoped HTTP %s response and sends no retirement fields", async (status, mark, kind) => {
      const post = vi.fn().mockResolvedValue(Response.json({ ok: true, withdrawal: { status: mark, withdrawnAt: time } },
        { status, headers: { Location: location } }));
      expect(await submitWithdrawal(approved, "why", signal, post)).toEqual({ kind, approvalId: "a", withdrawnAt: time });
      const [url, init] = post.mock.calls[0];
      expect(url).toBe("/api/control/t/withdrawals");
      expect(JSON.parse(init.body)).toEqual({ revisionId: "rev", approvalId: "a", reason: "why" });
    });
  it.each([[201, "already_withdrawn", time, location], [200, "withdrawn", time, location], [201, "withdrawn", null, location],
    [200, "already_withdrawn", time, "/api/control/peer/review/rev"]] as const)(
    "does not trust a mismatched status, timestamp or location", async (status, mark, withdrawnAt, loc) => {
      const post = vi.fn().mockResolvedValue(Response.json({ ok: true, withdrawal: { status: mark, withdrawnAt } },
        { status, headers: { Location: loc } }));
      expect(await submitWithdrawal(approved, "why", signal, post)).toEqual({ kind: "unknown" });
      expect(post).toHaveBeenCalledTimes(1);
    });
  it("rejects invalid reasons, wrong state and missing withdrawal hint before sending", async () => {
    const post = vi.fn();
    for (const why of ["", "  ", "x\0y", "x".repeat(1025)]) {
      expect(await submitWithdrawal(approved, why, signal, post)).toEqual({ kind: "invalidReason" });
    }
    for (const changes of [{ canWithdrawApproval: false, canRequestPromotion: true }, { state: "published" }, { approvalId: undefined }] as const) {
      expect(await submitWithdrawal({ ...approved, ...changes }, "why", signal, post)).toEqual({ kind: "denied" });
    }
    expect(post).not.toHaveBeenCalled();
  });
  it("treats a conflict without a valid release ID as unconfirmed", async () => {
    const post = vi.fn().mockResolvedValue(Response.json({ ok: false, code: "already_promoted", releaseId: "../foreign" }, { status: 409 }));
    expect(await submitWithdrawal(approved, "why", signal, post)).toEqual({ kind: "unknown" });
  });
});

describe("inspected validation command", () => {
  const candidate: Inspection = { ...review, state: "candidate", canRecordValidation: true, canRequestPromotion: false, canWithdrawApproval: false, canRetireRelease: false };
  it.each([undefined, null, false, "true", 1])("does not infer owner authority from a candidate state", async hint => {
    const get = vi.fn().mockResolvedValueOnce(Response.json(definition)).mockResolvedValueOnce(Response.json({
      ok: true, review: { ...review, state: "candidate", canRecordValidation: hint }
    }));
    expect(await inspect(get)).toMatchObject({ ok: true, value: { canRecordValidation: false } });
  });
  it("only posts an explicit evidence reference for an eligible inspection", async () => {
    const post = vi.fn();
    for (const value of ["", " ", " leading", "x".repeat(1025), "x\0y"]) {
      expect(await submitValidation(candidate, value, signal, post)).toBe("invalid");
    }
    expect(await submitValidation({ ...candidate, state: "validated" }, "ref", signal, post)).toBe("denied");
    expect(await submitValidation({ ...candidate, canRecordValidation: false }, "ref", signal, post)).toBe("denied");
    expect(post).not.toHaveBeenCalled();
  });
  it.each([
    [201, "rev", definitionDigest, "/api/control/peer/review/rev"],
    [201, "other", definitionDigest, "/api/control/t/review/rev"],
    [201, "rev", "wrong", "/api/control/t/review/rev"],
    [200, "rev", definitionDigest, "/api/control/t/review/rev"]
  ] as const)("requires a matching confirmation of the scoped write", async (status, revisionId, digest, location) => {
    const post = vi.fn().mockResolvedValue(Response.json({ ok: true, validation: { revisionId, definitionDigest: digest } },
      { status, headers: { Location: location } }));
    expect(await submitValidation(candidate, "ref", signal, post)).toBe("unknown");
    expect(post).toHaveBeenCalledTimes(1);
  });
  it("does not retry a lost response or assume the write was rolled back", async () => {
    const post = vi.fn().mockRejectedValue(new Error("connection closed"));
    expect(await submitValidation(candidate, "ref", signal, post)).toBe("unknown");
    expect(post).toHaveBeenCalledTimes(1);
  });
  it("bounds a stalled write and classifies the timeout as unconfirmed", async () => {
    const deadline = new AbortController();
    const timer = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    try {
      const post = vi.fn((_url: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("timeout")))));
      const pending = submitValidation(candidate, "ref", signal, post);
      expect(timer).toHaveBeenCalledWith(15_000);
      deadline.abort();
      expect(await pending).toBe("unknown");
      expect(post).toHaveBeenCalledTimes(1);
    } finally { timer.mockRestore(); }
  });
});
