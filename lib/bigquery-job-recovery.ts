import { createBigQueryAccessToken, hasBigQueryCredentials, type BigQueryEnv } from "./bigquery";

// Internal: load all five values from the admitted intent and pinned adapter
// configuration. Do not construct this binding from a client-supplied job ID.
type Binding = {
  tenantId: string;
  intentId: string;
  actionDigest: string;
  projectId: string;
  location: string;
};

type Observation =
  | { state: "not-found" | "pending" }
  | { state: "succeeded" | "cancelled" | "failed"; billedBytes: number | null };

async function digest(fields: string[]) {
  const bytes = new TextEncoder().encode(JSON.stringify(fields));
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function intentJobIdentity(binding: Binding) {
  if (![binding.tenantId, binding.intentId, binding.actionDigest, binding.projectId, binding.location]
    .every(value => typeof value === "string" && value.trim().length > 0)) throw new Error("Incomplete job binding");
  const { tenantId, intentId, actionDigest, projectId, location } = binding;
  const jobId = "odap_" + await digest(["odap.job.v1", tenantId, intentId]);
  // BigQuery label values allow at most 63 characters; use a 192-bit binding tag.
  const actionTag = (await digest(["odap.action.v1", jobId, actionDigest])).slice(0, 48);
  return { jobReference: { projectId, location, jobId }, labels: { odap_action: actionTag } };
}

export async function observeIntentJob(env: BigQueryEnv, binding: Binding): Promise<Observation> {
  if (!hasBigQueryCredentials(env) || env.BIGQUERY_PROJECT_ID !== binding.projectId ||
      env.BIGQUERY_LOCATION !== binding.location) throw new Error("BigQuery recovery target mismatch");
  const { jobReference: ref, labels } = await intentJobIdentity(binding);
  const token = await createBigQueryAccessToken(env);
  const url = new URL(`https://bigquery.googleapis.com/bigquery/v2/projects/${encodeURIComponent(ref.projectId)}/jobs/${ref.jobId}`);
  url.searchParams.set("location", ref.location);
  url.searchParams.set("fields", "jobReference,configuration(jobType,dryRun,labels),status(state,errorResult/reason),statistics/query/totalBytesBilled");
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, redirect: "error" });
  if (response.status === 404) return { state: "not-found" };
  if (!response.ok) throw new Error(`BigQuery job lookup failed (HTTP ${response.status})`);
  const job = await response.json();
  if (job?.jobReference?.jobId !== ref.jobId || job.jobReference.projectId !== ref.projectId ||
      typeof job.jobReference.location !== "string" || job.jobReference.location.toLowerCase() !== ref.location.toLowerCase() ||
      job.configuration?.jobType !== "QUERY" || (job.configuration.dryRun ?? false) !== false ||
      job.configuration.labels?.odap_action !== labels.odap_action) throw new Error("Unmatched BigQuery job");
  const status = job.status;
  if (status?.state === "PENDING" || status?.state === "RUNNING") return { state: "pending" };
  if (status?.state !== "DONE") throw new Error("Unrecognized BigQuery job state");
  if ("errorResult" in status && typeof status.errorResult?.reason !== "string") {
    throw new Error("Malformed BigQuery terminal status");
  }
  const value = job.statistics?.query?.totalBytesBilled;
  const billedBytes = typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value) &&
    Number.isSafeInteger(Number(value)) ? Number(value) : null;
  return { state: !status.errorResult ? "succeeded" : status.errorResult.reason === "stopped" ? "cancelled" : "failed", billedBytes };
}
