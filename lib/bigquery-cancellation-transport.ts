import { readJobCancellation } from "./bigquery-cancellation";
import type { ControlAccess } from "./control-storage";
import { readDelegatedCancellation } from "./delegated-cancellation";
import { withProviderDeadline } from "./provider-response";

type Cancellation = Awaited<ReturnType<typeof readJobCancellation>> | Awaited<ReturnType<typeof readDelegatedCancellation>>;
type Transport = {
  getAccessToken(signal: AbortSignal): Promise<string>;
  sendOnce(request: Request): Promise<Response>;
};
type Result = { state: "observation-required"; jobReference: Cancellation["jobReference"] } |
  { state: "not-sent"; reason: Exclude<Cancellation["state"], "requested">; jobReference: Cancellation["jobReference"] };
const unavailable = () => new Error("BigQuery cancellation transport unavailable");

// Internal, explicitly invoked transport for an already recorded owner request.
// No credential lookup, default sender, retry, outcome inference or accounting write.
export async function sendRequestedJobCancellation(access: ControlAccess, intentId: string,
  transport: Transport): Promise<Result> {
  const scope = { db: access.db, tenantId: access.tenantId, principalId: access.principalId };
  return sendCancellation(() => readJobCancellation(scope, intentId), transport);
}

export async function sendRequestedDelegatedJobCancellation(access: ControlAccess, audience: string, intentId: string,
  transport: Transport): Promise<Result> {
  const scope = { db: access.db, tenantId: access.tenantId, principalId: access.principalId };
  return sendCancellation(() => readDelegatedCancellation(scope, audience, intentId), transport);
}

async function sendCancellation(read: () => Promise<Cancellation>, transport: Transport): Promise<Result> {
  let handedOff = false;
  let ref: Cancellation["jobReference"];
  try {
    const initial = await read();
    const witness = "witness" in initial ? { ...initial.witness } : null;
    ref = { ...initial.jobReference };
    if (initial.state !== "requested") return { state: "not-sent", reason: initial.state, jobReference: ref };
    if (!/^[a-z][a-z0-9:.-]{4,127}$/i.test(ref.projectId) || !/^[a-z0-9-]{1,64}$/i.test(ref.location) ||
        !/^odap_[a-f0-9]{64}$/.test(ref.jobId)) throw unavailable();
    const tokenForJob = transport.getAccessToken.bind(transport), sendOnce = transport.sendOnce.bind(transport);
    const uncertain: Result = { state: "observation-required", jobReference: ref };
    try {
      return await withProviderDeadline<Result>(async signal => {
        const token = await tokenForJob(signal);
        if (signal.aborted || typeof token !== "string" || !token || /[^\x21-\x7e]/.test(token)) throw unavailable();
        // Authentication preparation may outlive an ownership change or terminal observation.
        const current = await read();
        if (signal.aborted || current.jobReference.projectId !== ref.projectId ||
            current.jobReference.location !== ref.location || current.jobReference.jobId !== ref.jobId) throw unavailable();
        if (witness && (!("witness" in current) || current.witness.audience !== witness.audience ||
            current.witness.claimBodyDigest !== witness.claimBodyDigest)) throw unavailable();
        if (current.state !== "requested") return { state: "not-sent", reason: current.state, jobReference: ref };
        const url = new URL(`https://bigquery.googleapis.com/bigquery/v2/projects/${encodeURIComponent(ref.projectId)}/jobs/${ref.jobId}/cancel`);
        url.searchParams.set("location", ref.location);
        const request = new Request(url, { method: "POST", redirect: "manual", signal,
          headers: { Authorization: `Bearer ${token}` } });
        handedOff = true;
        const response = await sendOnce(request);
        // Even HTTP 200 is not cancellation evidence. Do not consume provider diagnostics.
        void response.body?.cancel().catch(() => {});
        return uncertain;
      }, "BigQuery cancellation transport unavailable");
    } catch {
      if (handedOff) return uncertain;
      throw unavailable();
    }
  } catch {
    throw unavailable();
  }
}
