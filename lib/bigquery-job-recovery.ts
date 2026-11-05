import { createBigQueryAccessToken, hasBigQueryCredentials, type BigQueryEnv } from "./bigquery";
import { intentJobIdentity, type BigQueryJobBinding } from "./bigquery-job-identity";
export { intentJobIdentity } from "./bigquery-job-identity";

type Observation =
  | { state: "not-found" | "pending" }
  | { state: "succeeded" | "cancelled" | "failed"; billedBytes: number | null };

// Internal: obtain the binding from storage, never a client-supplied job ID.
export async function observeIntentJob(env: BigQueryEnv, binding: BigQueryJobBinding, expectedCap?: number): Promise<Observation> {
  if (expectedCap !== undefined && (!Number.isSafeInteger(expectedCap) || expectedCap <= 0)) {
    throw new Error("Invalid dispatch byte ceiling");
  }
  if (!hasBigQueryCredentials(env) || env.BIGQUERY_PROJECT_ID !== binding.projectId ||
      env.BIGQUERY_LOCATION !== binding.location) throw new Error("BigQuery recovery target mismatch");
  const { jobReference: ref, labels } = await intentJobIdentity(binding);
  const token = await createBigQueryAccessToken(env);
  const url = new URL(`https://bigquery.googleapis.com/bigquery/v2/projects/${encodeURIComponent(ref.projectId)}/jobs/${ref.jobId}`);
  url.searchParams.set("location", ref.location);
  url.searchParams.set("fields", "jobReference,configuration(jobType,dryRun,labels,query/maximumBytesBilled),status(state,errorResult/reason),statistics/query/totalBytesBilled");
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, redirect: "error" });
  if (response.status === 404) return { state: "not-found" };
  if (!response.ok) throw new Error(`BigQuery job lookup failed (HTTP ${response.status})`);
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
