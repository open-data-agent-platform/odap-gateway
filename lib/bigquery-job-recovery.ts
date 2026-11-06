import { createBigQueryAccessToken, hasBigQueryCredentials, type BigQueryEnv } from "./bigquery";
import { intentJobIdentity, type BigQueryJobBinding } from "./bigquery-job-identity";
import { readJobObservation, type Observation } from "./bigquery-job-metadata";
export { intentJobIdentity } from "./bigquery-job-identity";

// Internal: obtain the binding from storage, never a client-supplied job ID.
export async function observeIntentJob(env: BigQueryEnv, binding: BigQueryJobBinding, expectedCap?: number): Promise<Observation> {
  if (expectedCap !== undefined && (!Number.isSafeInteger(expectedCap) || expectedCap <= 0)) {
    throw new Error("Invalid dispatch byte ceiling");
  }
  if (!hasBigQueryCredentials(env) || env.BIGQUERY_PROJECT_ID !== binding.projectId ||
      env.BIGQUERY_LOCATION !== binding.location) throw new Error("BigQuery recovery target mismatch");
  const identity = await intentJobIdentity(binding);
  const ref = identity.jobReference;
  const token = await createBigQueryAccessToken(env);
  const url = new URL(`https://bigquery.googleapis.com/bigquery/v2/projects/${encodeURIComponent(ref.projectId)}/jobs/${ref.jobId}`);
  url.searchParams.set("location", ref.location);
  url.searchParams.set("fields", "jobReference,configuration(jobType,dryRun,labels,query/maximumBytesBilled),status(state,errorResult/reason),statistics/query/totalBytesBilled");
  return readJobObservation(signal => fetch(url, {
    headers: { Authorization: `Bearer ${token}` }, redirect: "manual", signal
  }), identity, expectedCap);
}
