import { gatewayPath } from "./gateway-path";
import type { Inspection } from "./review-inspection";

type Filter = { name: string; type: "INT64" | "BOOL" | "STRING" };
type Model = { tenantId: string; releaseId: string; metricId: string; target: string; filters: Filter[] };
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const id = /^[A-Za-z0-9_-]{1,128}$/;

// The inspected digest has already been checked. Use its logical fields only;
// the server independently loads the eligible release and binds the physical query.
export function previewModel(review: Inspection): Model | null {
  if (review.state !== "published" || !id.test(review.tenantId) || !review.releaseId || !id.test(review.releaseId)) return null;
  let d: unknown;
  try { d = JSON.parse(review.definitionJson); } catch { return null; }
  if (!record(d) || d.profile !== "odap.bigquery-metric.v1" || d.metricId !== review.metricId ||
      d.tenantId !== review.tenantId || d.sourceRevision !== review.sourceRevision ||
      typeof d.target !== "string" || !d.target.trim() || !record(d.filters) || Object.keys(d.filters).length > 16) return null;
  const filters: Filter[] = [];
  for (const [name, f] of Object.entries(d.filters)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name) || !record(f) ||
        (f.type !== "INT64" && f.type !== "BOOL" && f.type !== "STRING")) return null;
    filters.push({ name, type: f.type });
  }
  return { tenantId: review.tenantId, releaseId: review.releaseId, metricId: review.metricId, target: d.target, filters };
}

export function previewAction(model: Model, values: ReadonlyMap<string, string>) {
  const entries: [string, string | number | boolean][] = [];
  for (const { name, type } of model.filters) {
    const raw = values.get(name) ?? "";
    if (type === "INT64" && (!/^-?\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)))) return null;
    if (type === "BOOL" && raw !== "true" && raw !== "false") return null;
    entries.push([name, type === "INT64" ? Number(raw) : type === "BOOL" ? raw === "true" : raw]);
  }
  return { profile: "odap.metric-read.v1", metricId: model.metricId, target: model.target, parameters: Object.fromEntries(entries) };
}

export async function checkMetricPreview(model: Model, action: NonNullable<ReturnType<typeof previewAction>>,
  signal: AbortSignal, post: typeof fetch = fetch) {
  try {
    const res = await post(gatewayPath("/api/control/") + model.tenantId + "/metric-previews", { method: "POST",
      credentials: "same-origin", cache: "no-store", redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ releaseId: model.releaseId, action }) });
    const b: unknown = await res.json();
    if (record(b) && b.ok === false) {
      if (res.status === 404 && b.code === "metric_preview_unavailable") return "ineligible";
      if (res.status === 401 && b.code === "unauthenticated") return "signedOut";
      if (res.status === 403 && b.code === "tenant_access_denied") return "denied";
      if (res.status === 400 && b.code === "invalid_requested_action") return "invalid";
      if (res.status === 413 && b.code === "metric_preview_too_large") return "tooLarge";
    }
    if (res.status === 200 && record(b) && b.ok === true && record(b.preview) && b.preview.state === "compiled" &&
        b.preview.releaseId === model.releaseId && b.preview.parameterCount === model.filters.length) return "compiled";
  } catch { /* Unavailable or cancelled; never infer compilation from a failed response. */ }
  return "unavailable";
}
