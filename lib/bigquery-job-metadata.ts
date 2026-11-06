import type { intentJobIdentity } from "./bigquery-job-identity";
import { readBoundedProviderJson, withProviderDeadline } from "./provider-response";

export type Observation =
  | { state: "not-found" | "pending" }
  | { state: "succeeded" | "cancelled" | "failed"; billedBytes: number | null };

type Identity = Awaited<ReturnType<typeof intentJobIdentity>>;
const failure = () => new Error("BigQuery job lookup failed");

export function parseJobObservation(response: Response, identity: Identity, expectedCap?: number) {
  return readJobObservation(async () => response, identity, expectedCap);
}

export async function readJobObservation(lookup: (signal: AbortSignal) => Promise<Response>, identity: Identity,
  expectedCap?: number): Promise<Observation> {
  const result = await withProviderDeadline(async signal => {
    let response: Response;
    try { response = await lookup(signal); } catch { throw failure(); }
    if (signal.aborted || response.redirected || response.status !== 200) {
      void response.body?.cancel().catch(() => {});
      if (signal.aborted) throw failure();
      if (response.redirected) throw new Error("BigQuery job lookup redirected");
      return { status: response.status, value: null };
    }
    try { return { status: 200, value: await readBoundedProviderJson(response, signal) }; }
    catch { throw failure(); }
  }, "BigQuery job lookup failed");
  if (result.status === 404) return { state: "not-found" };
  if (result.status !== 200) throw new Error(`BigQuery job lookup failed (HTTP ${result.status})`);
  return parseMetadata(result.value, identity, expectedCap);
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function parseMetadata(value: unknown, { jobReference: ref, labels }: Identity, expectedCap?: number): Observation {
  const job = record(value), jobRef = record(job.jobReference), configuration = record(job.configuration);
  if (jobRef.jobId !== ref.jobId || jobRef.projectId !== ref.projectId ||
      typeof jobRef.location !== "string" || jobRef.location.toLowerCase() !== ref.location.toLowerCase() ||
      configuration.jobType !== "QUERY" || (configuration.dryRun !== undefined && configuration.dryRun !== false) ||
      (expectedCap !== undefined && record(configuration.query).maximumBytesBilled !== String(expectedCap)) ||
      record(configuration.labels).odap_action !== labels.odap_action) throw new Error("Unmatched BigQuery job");
  const status = record(job.status), reason = record(status.errorResult).reason;
  if (status.state === "PENDING" || status.state === "RUNNING") return { state: "pending" };
  if (status.state !== "DONE") throw new Error("Unrecognized BigQuery job state");
  if ("errorResult" in status && (typeof reason !== "string" || !reason.trim())) {
    throw new Error("Malformed BigQuery terminal status");
  }
  const bytes = record(record(job.statistics).query).totalBytesBilled;
  const billedBytes = typeof bytes === "string" && /^(0|[1-9][0-9]*)$/.test(bytes) &&
    Number.isSafeInteger(Number(bytes)) ? Number(bytes) : null;
  return { state: !status.errorResult ? "succeeded" : reason === "stopped" ? "cancelled" : "failed", billedBytes };
}
