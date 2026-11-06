import { readPreparedJob } from "./bigquery-job-storage";
import type { ControlAccess } from "./control-storage";
import { terminalOutcomesConflict } from "./terminal-outcome-sql";

type JobReference = Awaited<ReturnType<typeof readPreparedJob>>["identity"]["jobReference"];
type Outcome = "succeeded" | "failed" | "cancelled";

async function readStatus(access: ControlAccess, intentId: string, jobReference: JobReference) {
  const row = await access.db.prepare(`SELECT r.requested_by,r.requested_at,s.intent_id AS settled,
      ${terminalOutcomesConflict("c")} AS conflict,
      (SELECT o.outcome FROM bigquery_terminal_observations o
        WHERE o.tenant_id=c.tenant_id AND o.intent_id=c.intent_id LIMIT 1) AS outcome
    FROM dispatch_claims c JOIN bigquery_job_bindings b USING(tenant_id,intent_id)
    JOIN control_memberships m ON m.tenant_id=c.tenant_id AND m.principal_id=? AND m.role='owner' AND m.active=1
    LEFT JOIN bigquery_cancellation_requests r ON r.tenant_id=c.tenant_id AND r.intent_id=c.intent_id AND r.job_id=b.job_id
    LEFT JOIN cost_settlements s ON s.tenant_id=c.tenant_id AND s.intent_id=c.intent_id
    WHERE c.tenant_id=? AND c.intent_id=? AND c.maximum_bytes_billed IS NOT NULL AND b.job_id=?`)
    .bind(access.principalId, access.tenantId, intentId, jobReference.jobId)
    .first<{ conflict: number; requested_by: string | null; requested_at: string | null; settled: string | null; outcome: Outcome | null }>();
  if (!row) throw new Error("Claimed BigQuery job unavailable");
  if (row.conflict) throw new Error("Conflicting terminal outcomes");
  const request = row.requested_by !== null && row.requested_at !== null
    ? { requestedBy: row.requested_by, requestedAt: row.requested_at } : null;
  if (row.outcome !== null) return { state: "terminal" as const, jobReference, request, outcome: row.outcome };
  if (row.settled !== null) return { state: "settled-unverified" as const, jobReference, request };
  if (request) return { state: "requested" as const, jobReference, request };
  return { state: "not-requested" as const, jobReference, request: null };
}

export async function readJobCancellation(access: ControlAccess, intentId: string) {
  const { identity } = await readPreparedJob(access, intentId);
  return readStatus(access, intentId, identity.jobReference);
}

// Internal bookkeeping only. There is intentionally no warehouse transport.
export async function requestJobCancellation(access: ControlAccess, intentId: string) {
  const { identity } = await readPreparedJob(access, intentId);
  const write = await access.db.prepare(`INSERT INTO bigquery_cancellation_requests
    (tenant_id,intent_id,job_id,requested_by) VALUES(?,?,?,?)`)
    .bind(access.tenantId, intentId, identity.jobReference.jobId, access.principalId).run();
  if (!write.success) throw new Error("Cancellation request write failed");
  const status = await readStatus(access, intentId, identity.jobReference);
  if (status.state === "not-requested") throw new Error("Cancellation request not recorded");
  return status;
}
