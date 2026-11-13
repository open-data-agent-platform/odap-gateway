import type { ControlAccess } from "./control-storage";
import { loadDelegatedClaimSnapshot, observeDelegatedClaim } from "./delegated-job-recovery";

type Transport = {
  projectId: string;
  location: string;
  getAccessToken(signal: AbortSignal): Promise<string>;
  sendOnce(request: Request): Promise<Response>;
};
const unavailable = () => new Error("Delegated observation transport unavailable");
const pins = ["compiled_body_digest", "cap", "project_id", "location", "job_id", "action_tag",
  "receipt_id", "action_digest", "contract_id", "release_id"] as const;

// Internal metadata-only adapter. No default credentials, sender, polling or retry.
export async function observeDelegatedJobWithTransport(access: ControlAccess, audience: string, intentId: string,
  transport: Transport) {
  try {
    const scope = { db: access.db, tenantId: access.tenantId, principalId: access.principalId };
    const args: Parameters<typeof loadDelegatedClaimSnapshot>[1] = [scope.tenantId, intentId, audience, scope.principalId];
    const initial = await loadDelegatedClaimSnapshot(scope.db, args), expected = { ...initial.row };
    const ref = { ...initial.identity.jobReference };
    const { projectId, location } = transport;
    if (projectId !== ref.projectId || location !== ref.location ||
        !/^[a-z][a-z0-9:.-]{4,127}$/i.test(projectId) || !/^[a-z0-9-]{1,64}$/i.test(location) ||
        !/^odap_[a-f0-9]{64}$/.test(ref.jobId)) throw unavailable();
    const tokenForJob = transport.getAccessToken.bind(transport), sendOnce = transport.sendOnce.bind(transport);
    return await observeDelegatedClaim(scope, audience, intentId, async (reference, signal) => {
      if (signal.aborted || reference.projectId !== ref.projectId || reference.location !== ref.location ||
          reference.jobId !== ref.jobId) throw unavailable();
      const token = await tokenForJob(signal);
      if (signal.aborted || typeof token !== "string" || !token || /[^\x21-\x7e]/.test(token)) throw unavailable();
      // Token preparation may outlive ownership or claim changes. Recheck before GET.
      const current = await loadDelegatedClaimSnapshot(scope.db, args);
      if (signal.aborted || pins.some(key => current.row[key] !== expected[key])) throw unavailable();
      const url = new URL(`https://bigquery.googleapis.com/bigquery/v2/projects/${encodeURIComponent(projectId)}/jobs/${ref.jobId}`);
      url.searchParams.set("location", location);
      url.searchParams.set("fields", "jobReference,configuration(jobType,dryRun,labels,query/maximumBytesBilled),status(state,errorResult/reason),statistics/query/totalBytesBilled");
      return sendOnce(new Request(url, { method: "GET", redirect: "manual", signal,
        headers: { Authorization: `Bearer ${token}` } }));
    });
  } catch {
    throw unavailable();
  }
}
