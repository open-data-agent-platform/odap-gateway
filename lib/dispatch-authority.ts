import { readPreparedJob } from "./bigquery-job-storage";
import type { intentJobIdentity } from "./bigquery-job-recovery";
import { canonicalControlJson, isApprovalContract, isSemanticRelease, sha256Text, type SemanticRelease } from "./control-objects";
import { compileReleasedMetric } from "./metric-compiler";
import { bigQueryByteCeiling } from "./bigquery-byte-ceiling";
import type { ControlAccess } from "./control-storage";

export type MetricRead = {
  target: string;
  metricId: string;
  parameters: Record<string, string | number | boolean | null>;
};
type Submission = {
  identity: Awaited<ReturnType<typeof intentJobIdentity>>;
  release: SemanticRelease;
  queryConfig: Awaited<ReturnType<typeof compileReleasedMetric>> & { maximumBytesBilled: string };
};
export type ReadAdapter<T> = {
  projectId: string; location: string;
  maxBytesBilled?: number;
  loadDefinition(key: { tenantId: string; releaseId: string }): Promise<string>;
  // Prepare local request data and credentials only. No warehouse submission
  // until the dispatcher invokes the returned function after its atomic claim.
  prepareRead(job: Submission): Promise<() => Promise<T>>;
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
  const { projectId, location, maxBytesBilled } = adapter;
  if (maxBytesBilled !== undefined && (!Number.isSafeInteger(maxBytesBilled) || maxBytesBilled <= 0)) {
    throw new Error("Invalid adapter byte ceiling");
  }
  const target = action.target;
  const prepare = adapter.prepareRead.bind(adapter);
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
  const row = await db.prepare(`SELECT contract_payload,release_payload,reserved_units,micro_usd_per_tib,max_job_bytes
    FROM dispatch_priced_reads WHERE ${scope} AND NOT EXISTS(
      SELECT 1 FROM dispatch_claims WHERE tenant_id=? AND intent_id=?)`).bind(...args, tenantId, intentId).first<{ contract_payload: string; release_payload: string;
      reserved_units: number; micro_usd_per_tib: number; max_job_bytes: number }>();
  if (!row) throw new Error("Dispatch authority unavailable or already claimed");
  const contract: unknown = JSON.parse(row.contract_payload);
  const release: unknown = JSON.parse(row.release_payload);
  if (!isApprovalContract(contract) || !isSemanticRelease(release) || contract.tenantId !== tenantId ||
      release.tenantId !== tenantId || contract.id !== job.receipt.contractId ||
      release.id !== job.receipt.semanticReleaseId || contract.semanticReleaseId !== release.id) {
    throw new Error("Invalid dispatch authority");
  }
  const ceiling = bigQueryByteCeiling(row.reserved_units, row.micro_usd_per_tib,
    Math.min(row.max_job_bytes, maxBytesBilled ?? row.max_job_bytes));
  const definition = await loadDefinition({ tenantId, releaseId: release.id });
  const compiled = await compileReleasedMetric(release, definition, canonicalAction, projectId);
  const queryConfig = { ...compiled, maximumBytesBilled: String(ceiling) };
  const submit = await prepare({ identity: job.identity, release, queryConfig });
  if (typeof submit !== "function") throw new Error("Adapter failed to prepare submission");
  // Mutable facts and database time are reread under the claim's write lock.
  // Never retry submission after a conflict, timeout, or ambiguous storage result.
  const claim = await db.prepare(`INSERT INTO dispatch_claims(tenant_id,intent_id,claimed_by,maximum_bytes_billed)
    SELECT tenant_id,intent_id,?,? FROM dispatch_priced_reads WHERE ${scope} AND contract_payload=? AND release_payload=?
    AND reserved_units=? AND micro_usd_per_tib=? AND max_job_bytes=?
    AND NOT EXISTS(SELECT 1 FROM dispatch_claims WHERE tenant_id=? AND intent_id=?)`)
    .bind(operator, ceiling, ...args, row.contract_payload, row.release_payload,
      row.reserved_units, row.micro_usd_per_tib, row.max_job_bytes, tenantId, intentId).run();
  if (!claim.success || claim.meta?.changes !== 1) throw new Error("Dispatch denied or already claimed");
  return submit();
}
