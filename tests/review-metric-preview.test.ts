import { describe, expect, it, vi } from "vitest";
import { checkMetricPreview, previewAction, previewModel } from "../lib/review-metric-preview";
import type { Inspection } from "../lib/review-inspection";
import metric from "./fixtures/revenue-metric.json";

const definition = { ...metric, filters: { ...metric.filters, paid: { type: "BOOL", column: "paid" }, region: { type: "STRING", column: "region" } } };
const review: Inspection = { tenantId: metric.tenantId, revisionId: "v1", releaseId: "published-1", metricId: metric.metricId,
  state: "published", sourceRevision: metric.sourceRevision, definitionDigest: "fixture", definitionJson: JSON.stringify(definition),
  canRecordValidation: false, canRequestPromotion: false, canWithdrawApproval: false, canRetireRelease: false };
const model = previewModel(review)!;
const inputs = new Map([["year", "0"], ["paid", "false"], ["region", "SELECT 'test'"]]);
const action = previewAction(model, inputs)!;

describe("structured preview client", () => {
  it("uses logical fields only, preserves typed false and zero, and never treats a string as SQL", () => {
    expect(action).toEqual({ profile: "odap.metric-read.v1", target: metric.target, metricId: metric.metricId,
      parameters: { year: 0, paid: false, region: "SELECT 'test'" } });
    expect(previewAction({ ...model, filters: [] }, inputs)?.parameters).toEqual({});
    for (const year of ["", "1.25", "9e3", " ", "9007199254740992"]) {
      expect(previewAction(model, new Map(inputs).set("year", year))).toBeNull();
    }
    expect(previewAction(model, new Map(inputs).set("paid", ""))).toBeNull();
  });

  it("does not offer a preview for an unpublished, inconsistent or unsupported definition", () => {
    expect(previewModel({ ...review, state: "retired" })).toBeNull();
    expect(previewModel({ ...review, metricId: "other" })).toBeNull();
    for (const d of [null, { ...definition, filters: [] }, { ...definition, filters: { f: { type: "FLOAT64" } } }]) {
      expect(previewModel({ ...review, definitionJson: JSON.stringify(d) })).toBeNull();
    }
  });

  it("accepts only a matching release and parameter count and never retries on another route", async () => {
    const preview = { releaseId: model.releaseId, parameterCount: 3, state: "compiled" };
    for (const [summary, expected] of [[preview, "compiled"], [{ ...preview, releaseId: "peer" }, "unavailable"],
      [{ ...preview, parameterCount: "3" }, "unavailable"], [{ ...preview, state: "approved" }, "unavailable"]] as const) {
      const post = vi.fn().mockResolvedValue(Response.json({ ok: true, preview: summary }));
      expect(await checkMetricPreview(model, action, new AbortController().signal, post)).toBe(expected);
      expect(post).toHaveBeenCalledTimes(1);
      expect(post).toHaveBeenCalledWith("/api/control/t/metric-previews", expect.objectContaining({
        method: "POST", credentials: "same-origin", body: JSON.stringify({ releaseId: model.releaseId, action }) }));
    }
  });

  it.each([[401, "unauthenticated", "signedOut"], [403, "tenant_access_denied", "denied"],
    [404, "metric_preview_unavailable", "ineligible"], [404, "other", "unavailable"],
    [413, "metric_preview_too_large", "tooLarge"], [400, "invalid_requested_action", "invalid"]] as const)(
    "maps status %s with code %s to %s", async (status, code, expected) => {
      expect(await checkMetricPreview(model, action, new AbortController().signal,
        async () => Response.json({ ok: false, code }, { status }))).toBe(expected);
    });
});
