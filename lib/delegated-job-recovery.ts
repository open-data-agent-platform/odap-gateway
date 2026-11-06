import { intentJobIdentity } from "./bigquery-job-identity";
import { parseJobObservation } from "./bigquery-job-metadata";
import { isEvidenceReceipt } from "./control-objects";
import type { ControlAccess } from "./control-storage";
import type { D1Database } from "./d1";
import { terminalOutcomesConflict } from "./terminal-outcome-sql";

type Lookup = (ref: Readonly<Awaited<ReturnType<typeof intentJobIdentity>>["jobReference"]>) => Promise<Response>;
type Terminal = "succeeded" | "failed" | "cancelled";
type Row = {
  compiled_body_digest: string; cap: number; project_id: string; location: string; job_id: string;
  action_tag: string; receipt_id: string; action_digest: string; contract_id: string; release_id: string; receipt_payload: string;
  conflict: number; outcome: Terminal | null; billed_bytes: number | null; observed_at: string | null; observed_by: string | null;
};
type Scope = [tenantId: string, intentId: string, audience: string, owner: string];
const scoped = "j.tenant_id=? AND j.intent_id=? AND j.audience=? AND j.operator_id=?";

export async function loadDelegatedClaimSnapshot(db: D1Database, scope: Scope) {
  const row = await db.prepare(`SELECT j.*,o.outcome,o.billed_bytes,o.observed_at,o.observed_by,
      ${terminalOutcomesConflict("j")} AS conflict
    FROM recoverable_delegated_jobs j LEFT JOIN bigquery_terminal_observations o
    ON o.tenant_id=j.tenant_id AND o.intent_id=j.intent_id AND o.delegation_audience=j.audience
      AND o.claim_body_digest=j.compiled_body_digest WHERE ${scoped} ORDER BY o.has_bytes DESC LIMIT 1`)
    .bind(...scope).first<Row>();
  if (!row) throw new Error("Verified delegated claim unavailable");
  if (row.conflict) throw new Error("Conflicting terminal outcomes");
  const [tenantId,intentId] = scope;
  const identity = await intentJobIdentity({ tenantId,intentId,actionDigest: row.action_digest,
    projectId: row.project_id,location: row.location });
  const receipt: unknown = JSON.parse(row.receipt_payload);
  if (row.job_id !== identity.jobReference.jobId || row.action_tag !== identity.labels.odap_action ||
      row.receipt_id !== "pending_"+row.job_id || !Number.isSafeInteger(row.cap) || row.cap <= 0 ||
      !isEvidenceReceipt(receipt) || receipt.id !== row.receipt_id || receipt.tenantId !== tenantId ||
      receipt.intentId !== intentId || receipt.outcome !== "pending" || receipt.contractId !== row.contract_id ||
      receipt.semanticReleaseId !== row.release_id) throw new Error("Invalid delegated recovery binding");
  const observation = row.outcome === null ? null : { state: row.outcome, billedBytes: row.billed_bytes,
    observedAt: row.observed_at, observedBy: row.observed_by };
  return { row, identity, result: { jobReference: identity.jobReference, receiptId: row.receipt_id, observation } };
}

// Restart inspection reads only local evidence. No new job can be allocated.
export async function readDelegatedRecovery(access: ControlAccess, audience: string, intentId: string) {
  return (await loadDelegatedClaimSnapshot(access.db,[access.tenantId,intentId,audience,access.principalId])).result;
}

// No default observer or transport. A lookup result is job metadata, never a bill.
export async function observeDelegatedClaim(access: ControlAccess, audience: string, intentId: string, lookup: Lookup) {
  if (typeof lookup !== "function") throw new Error("Explicit job observer required");
  const { db,tenantId,principalId } = access;
  const scope: Scope = [tenantId,intentId,audience,principalId];
  const { row,identity } = await loadDelegatedClaimSnapshot(db,scope);
  const response = await lookup({ ...identity.jobReference });
  const sample = await parseJobObservation(response,identity,row.cap);
  if ("billedBytes" in sample) {
    const write = await db.prepare(`INSERT INTO bigquery_terminal_observations
      (tenant_id,intent_id,outcome,billed_bytes,has_bytes,observed_by,delegation_audience,claim_body_digest)
      SELECT j.tenant_id,j.intent_id,?,?,?,j.operator_id,j.audience,j.compiled_body_digest
      FROM recoverable_delegated_jobs j WHERE ${scoped} AND j.compiled_body_digest=? AND j.cap=?
        AND j.project_id=? AND j.location=? AND j.job_id=? AND j.action_tag=? AND j.receipt_id=?
        AND NOT ${terminalOutcomesConflict("j")}`)
      .bind(sample.state,sample.billedBytes,Number(sample.billedBytes!==null),...scope,row.compiled_body_digest,
        row.cap,row.project_id,row.location,row.job_id,row.action_tag,row.receipt_id).run();
    if (!write.success) throw new Error("Delegated observation not confirmed");
  }
  // Recheck owner access even after a 404. A weaker lookup cannot erase the
  // first durable outcome or a later known byte count.
  const after = await loadDelegatedClaimSnapshot(db,scope);
  if (after.row.compiled_body_digest !== row.compiled_body_digest || after.row.cap !== row.cap ||
      after.row.project_id !== row.project_id || after.row.location !== row.location ||
      after.row.job_id !== row.job_id || after.row.action_tag !== row.action_tag || after.row.receipt_id !== row.receipt_id)
    throw new Error("Delegated claim changed during lookup");
  const saved = after.result.observation;
  if ("billedBytes" in sample && (saved?.state !== sample.state ||
      (sample.billedBytes !== null && saved.billedBytes !== sample.billedBytes))) throw new Error("Delegated observation not confirmed");
  return { ...after.result, observation: saved ?? sample };
}
