import type { ControlAccess } from "./control-storage";
import { dispatchPreparedMetricRead, type MetricRead, type ReadAdapter } from "./dispatch-authority";
import { readBoundedProviderJson, withProviderDeadline } from "./provider-response";

type JobRef = { projectId: string; location: string; jobId: string };
type Handoff = { state: "accepted" | "observation-required"; jobReference: JobRef };
type Transport = {
  projectId: string;
  location: string;
  maxBytesBilled: number;
  loadDefinition: ReadAdapter<Handoff>["loadDefinition"];
  getAccessToken(): Promise<string>;
  sendOnce(request: Request): Promise<Response>;
};

// No default network client, environment lookup or public HTTP entry point.
// Only this gated entry point can construct a governed jobs.insert request.
export async function dispatchBigQueryMetricRead(access: ControlAccess, intentId: string,
  subject: { principalId: string; agentId: string }, action: MetricRead, transport: Transport): Promise<Handoff> {
  const { projectId, location, maxBytesBilled } = transport;
  if (!Number.isSafeInteger(maxBytesBilled) || maxBytesBilled <= 0) throw new Error("Explicit transport byte ceiling required");
  const tokenForJob = transport.getAccessToken.bind(transport);
  const sendOnce = transport.sendOnce.bind(transport);
  return dispatchPreparedMetricRead<Handoff>(access, intentId, subject, action, {
    projectId, location, maxBytesBilled, loadDefinition: transport.loadDefinition.bind(transport),
    async prepareRead({ identity, queryConfig }) {
      const ref = identity.jobReference;
      const url = new URL(`https://bigquery.googleapis.com/bigquery/v2/projects/${encodeURIComponent(ref.projectId)}/jobs`);
      url.searchParams.set("fields", "jobReference,configuration(jobType,dryRun,labels,query/maximumBytesBilled)");
      let token: string;
      try { token = await tokenForJob(); } catch { throw new Error("BigQuery transport authentication unavailable"); }
      if (typeof token !== "string" || !token || /[^\x21-\x7e]/.test(token)) {
        throw new Error("BigQuery transport authentication unavailable");
      }
      // Workers supports manual redirects; non-success replies stay observation-only.
      const request = new Request(url, { method: "POST", redirect: "manual",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ jobReference: ref, configuration: { labels: identity.labels, query: queryConfig } }) });
      return async () => {
        const uncertain: Handoff = { state: "observation-required", jobReference: ref };
        try {
          return await withProviderDeadline<Handoff>(async signal => {
            const response = await sendOnce(new Request(request, { signal }));
            if (signal.aborted || !response.ok || response.redirected) {
              void response.body?.cancel().catch(() => {});
              return uncertain;
            }
            const job = record(await readBoundedProviderJson(response, signal));
            const r = record(job.jobReference), c = record(job.configuration);
            if (r.projectId !== ref.projectId || r.jobId !== ref.jobId || typeof r.location !== "string" ||
                r.location.toLowerCase() !== ref.location.toLowerCase() || c.jobType !== "QUERY" ||
                (c.dryRun !== undefined && c.dryRun !== false) ||
                record(c.labels).odap_action !== identity.labels.odap_action ||
                record(c.query).maximumBytesBilled !== queryConfig.maximumBytesBilled) return uncertain;
            return { state: "accepted", jobReference: ref };
          }, "BigQuery submission acknowledgment timed out");
        } catch { return uncertain; }
      };
    }
  });
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
