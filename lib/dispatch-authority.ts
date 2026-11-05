import { readPreparedJob } from "./bigquery-job-storage";
import type { intentJobIdentity } from "./bigquery-job-recovery";
import { canonicalControlJson, isApprovalContract, isSemanticRelease, sha256Text, type SemanticRelease } from "./control-objects";
import { compileReleasedMetric } from "./metric-compiler";
import type { ControlAccess } from "./control-storage";

type MetricRead = {
  target: string;
  metricId: string;
  parameters: Record<string, string | number | boolean | null>;
};
type Submission = {
  identity: Awaited<ReturnType<typeof intentJobIdentity>>;
  release: SemanticRelease;
  queryConfig: Awaited<ReturnType<typeof compileReleasedMetric>>;
};
type ReadAdapter<T> = {
  projectId: string; location: string;
  loadDefinition(key: { tenantId: string; releaseId: string }): Promise<string>;
  submitRead(job: Submission): Promise<T>;
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
}

// This narrow action shape does not accept SQL or adapter options. Pass the
// serialized copy to the adapter, never the caller's mutable parameter object.
export async function bindMetricRead(action: MetricRead) {
  if (!record(action) || Object.keys(action).some(k => !["target", "metricId", "parameters"].includes(k)) ||
      typeof action.target !== "string" || !action.target.trim() || typeof action.metricId !== "string" ||
      !action.metricId.trim() || !record(action.parameters) || !Object.values(action.parameters).every(v =>
        v === null || ["string", "boolean", "number"].includes(typeof v))) throw new Error("Invalid metric read");
  const canonicalAction = canonicalControlJson({ profile: "odap.metric-read.v1", target: action.target,
    metricId: action.metricId, parameters: action.parameters });
  return { canonicalAction, actionDigest: await sha256Text(canonicalAction) };
}

// Internal dispatcher only. Access is the verified tenant operator; subject and
// agent come from authenticated delegation, never from an untrusted request body.
export async function dispatchPreparedMetricRead<T>(access: ControlAccess, intentId: string,
  subject: { principalId: string; agentId: string }, action: MetricRead, adapter: ReadAdapter<T>): Promise<T> {
  const { db, tenantId, principalId: operator } = access;
  const { principalId, agentId } = subject;
  const { projectId, location } = adapter;
  const target = action.target;
  const submit = adapter.submitRead.bind(adapter);
  const loadDefinition = adapter.loadDefinition.bind(adapter);
  const { canonicalAction, actionDigest } = await bindMetricRead(action);
  const job = await readPreparedJob({ db, tenantId, principalId: operator }, intentId);
  if (job.binding.actionDigest !== actionDigest || job.binding.projectId !== projectId ||
      job.binding.location !== location) throw new Error("Dispatch binding mismatch");

  const scope = `tenant_id=? AND intent_id=? AND principal_id=? AND agent_id=? AND target=? AND action_digest=?
    AND project_id=? AND location=? AND job_id=? AND action_tag=? AND receipt_id=?
    AND EXISTS(SELECT 1 FROM control_memberships WHERE tenant_id=? AND principal_id=? AND active=1 AND role='owner')`;
  const args = [tenantId, intentId, principalId, agentId, target, actionDigest, projectId, location,
    job.identity.jobReference.jobId, job.identity.labels.odap_action, job.receipt.id, tenantId, operator];
  const row = await db.prepare(`SELECT contract_payload,release_payload FROM dispatch_eligible_reads WHERE ${scope}`)
    .bind(...args).first<{ contract_payload: string; release_payload: string }>();
  if (!row) throw new Error("Dispatch authority unavailable");
  const contract: unknown = JSON.parse(row.contract_payload);
  const release: unknown = JSON.parse(row.release_payload);
  if (!isApprovalContract(contract) || !isSemanticRelease(release) || contract.tenantId !== tenantId ||
      release.tenantId !== tenantId || contract.id !== job.receipt.contractId ||
      release.id !== job.receipt.semanticReleaseId || contract.semanticReleaseId !== release.id) {
    throw new Error("Invalid dispatch authority");
  }
  const definition = await loadDefinition({ tenantId, releaseId: release.id });
  const queryConfig = await compileReleasedMetric(release, definition, canonicalAction, projectId);
  // Mutable facts and database time are reread under the claim's write lock.
  // Never retry submission after a conflict, timeout, or ambiguous storage result.
  const claim = await db.prepare(`INSERT INTO dispatch_claims(tenant_id,intent_id,claimed_by)
    SELECT tenant_id,intent_id,? FROM dispatch_eligible_reads WHERE ${scope} AND contract_payload=? AND release_payload=?
    ON CONFLICT(tenant_id,intent_id) DO NOTHING`)
    .bind(operator, ...args, row.contract_payload, row.release_payload).run();
  if (!claim.success || claim.meta?.changes !== 1) throw new Error("Dispatch denied or already claimed");
  return submit({ identity: job.identity, release, queryConfig });
}
