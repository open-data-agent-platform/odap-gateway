import { gatewayPath } from "./gateway-path";
import type { QueryRunPreview } from "./phase2";

type Preview = Pick<QueryRunPreview, "scannedBytes" | "estimatedCostUsd" | "expectedRuntimeMs" |
  "projectedColumns" | "referencedTables" | "checks"> & {
  mode: "live" | "simulated"; status: "approved" | "needs_approval"; auditId: string | null; jobRef: string | null;
};
export type WorkbenchResult = { state: "ready"; preview: Preview } |
  { state: "sign_in" | "denied" | "invalid" | "unavailable" };

const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const quantity = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const isCheck = (v: unknown): v is Preview["checks"][number] => record(v) &&
  (v.status === "pass" || v.status === "warn") && typeof v.label === "string" && typeof v.detail === "string";

// Never reinterpret an HTTP refusal, failed job or malformed body as a local estimate.
export async function requestWorkbenchPreview(input: { sql: string; workspace: string; queryType: string },
  signal: AbortSignal, send: typeof fetch = fetch): Promise<WorkbenchResult> {
  try {
    const res = await send(gatewayPath("/api/query/dry-run"), { method: "POST", credentials: "same-origin",
      cache: "no-store", redirect: "error", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input), signal });
    if (res.status === 401) return { state: "sign_in" };
    if (res.status === 403) return { state: "denied" };
    if (res.status === 400) return { state: "invalid" };
    if (res.status !== 200) return { state: "unavailable" };
    const body: unknown = await res.json();
    if (!record(body) || body.ok !== true || !record(body.preview)) return { state: "unavailable" };
    const p = body.preview;
    const errorCode = record(p.error) ? p.error.code : undefined;
    if (p.status === "blocked") {
      return { state: !p.error || errorCode === "schema_policy_blocked" || errorCode === "blocked_before_bigquery"
        ? "denied" : "unavailable" };
    }
    if ((p.mode !== "live" && p.mode !== "simulated") || (p.status !== "approved" && p.status !== "needs_approval") ||
        (p.error !== undefined && !(p.mode === "simulated" && (errorCode === "bigquery_not_configured" || errorCode === "bigquery_simulated_mode"))) ||
        !quantity(p.scannedBytes) || !quantity(p.estimatedCostUsd) || !quantity(p.expectedRuntimeMs) || !quantity(p.projectedColumns) ||
        !Array.isArray(p.referencedTables) || !p.referencedTables.every((t: unknown) => typeof t === "string") ||
        !Array.isArray(p.checks) || !p.checks.every(isCheck) || typeof p.persisted !== "boolean" ||
        (p.persisted && (typeof p.runId !== "string" || !p.runId.trim()))) return { state: "unavailable" };
    const ref = p.jobReference;
    const jobRef = p.mode === "live" && record(ref) && typeof ref.projectId === "string"
      ? [ref.projectId, typeof ref.location === "string" ? ref.location : null].filter(Boolean).join(" / ") : null;
    return { state: "ready", preview: { mode:p.mode, status:p.status, scannedBytes:p.scannedBytes,
      estimatedCostUsd:p.estimatedCostUsd, expectedRuntimeMs:p.expectedRuntimeMs, projectedColumns:p.projectedColumns,
      referencedTables:p.referencedTables, checks:p.checks, jobRef, auditId:p.persisted && typeof p.runId === "string" ? p.runId : null } };
  } catch {
    return { state: "unavailable" };
  }
}
