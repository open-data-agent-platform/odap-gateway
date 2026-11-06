import type { readEvidenceCoverage } from "./evidence-coverage";

export type CoverageReport = NonNullable<Awaited<ReturnType<typeof readEvidenceCoverage>>>;
export const buckets = [
  ["pendingOutcome", "Awaiting outcome"], ["pendingBilling", "Awaiting final bill"],
  ["attributedSettlements", "Attributed settlements"], ["unattributedSettlements", "Unattributed settlements"],
  ["missingEvidence", "Missing evidence"]
] as const;
const totals = ["recordedAttempts", "admitted", "missingReleaseRefusals"] as const;
const keys = [...totals, ...buckets.map(([key]) => key)];

export type Inspection = { state: "ready"; report: CoverageReport } |
  { state: "invalid" | "unauthenticated" | "denied" | "unavailable" };

function validReport(value: unknown): value is CoverageReport {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length || !keys.every(k => Object.hasOwn(row,k) &&
      typeof row[k] === "number" && Number.isSafeInteger(row[k]) && row[k] >= 0)) return false;
  const report = value as CoverageReport;
  return report.recordedAttempts === report.admitted + report.missingReleaseRefusals &&
    report.admitted === buckets.reduce((n,[key]) => n + report[key], 0);
}

export async function inspectCoverage(tenant: string, signal: AbortSignal, get: typeof fetch = fetch): Promise<Inspection> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(tenant)) return { state: "invalid" };
  try {
    const res = await get("/api/control/" + tenant + "/evidence-coverage", {
      method: "GET", credentials: "same-origin", cache: "no-store", redirect: "error", signal
    });
    if (res.status === 401) return { state: "unauthenticated" };
    if (res.status === 403) return { state: "denied" };
    if (res.status !== 200) return { state: "unavailable" };
    const body = await res.json();
    if (body?.ok !== true || !validReport(body.coverage)) return { state: "unavailable" };
    return { state: "ready", report: body.coverage };
  } catch {
    return { state: "unavailable" };
  }
}
