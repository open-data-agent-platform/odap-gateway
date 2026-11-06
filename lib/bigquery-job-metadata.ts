import type { intentJobIdentity } from "./bigquery-job-identity";

export type Observation =
  | { state: "not-found" | "pending" }
  | { state: "succeeded" | "cancelled" | "failed"; billedBytes: number | null };

export async function parseJobObservation(response: Response, { jobReference: ref, labels }: Awaited<ReturnType<typeof intentJobIdentity>>,
  expectedCap?: number): Promise<Observation> {
  if (response.redirected) throw new Error("BigQuery job lookup redirected");
  if (response.status === 404) return { state: "not-found" };
  if (response.status !== 200) throw new Error(`BigQuery job lookup failed (HTTP ${response.status})`);
  const job = await response.json();
  if (job?.jobReference?.jobId !== ref.jobId || job.jobReference.projectId !== ref.projectId ||
      typeof job.jobReference.location !== "string" || job.jobReference.location.toLowerCase() !== ref.location.toLowerCase() ||
      job.configuration?.jobType !== "QUERY" || (job.configuration.dryRun !== undefined && job.configuration.dryRun !== false) ||
      (expectedCap !== undefined && job.configuration.query?.maximumBytesBilled !== String(expectedCap)) ||
      job.configuration.labels?.odap_action !== labels.odap_action) throw new Error("Unmatched BigQuery job");
  const status = job.status;
  if (status?.state === "PENDING" || status?.state === "RUNNING") return { state: "pending" };
  if (status?.state !== "DONE") throw new Error("Unrecognized BigQuery job state");
  if ("errorResult" in status && (typeof status.errorResult?.reason !== "string" || !status.errorResult.reason.trim())) {
    throw new Error("Malformed BigQuery terminal status");
  }
  const value = job.statistics?.query?.totalBytesBilled;
  const billedBytes = typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value) &&
    Number.isSafeInteger(Number(value)) ? Number(value) : null;
  return { state: !status.errorResult ? "succeeded" : status.errorResult.reason === "stopped" ? "cancelled" : "failed", billedBytes };
}
