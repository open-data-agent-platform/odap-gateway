import type { ControlAccess } from "./control-storage";
import { loadDelegatedClaimSnapshot } from "./delegated-job-recovery";
import { terminalOutcomesConflict } from "./terminal-outcome-sql";

const pinned = `j.tenant_id=? AND j.intent_id=? AND j.audience=? AND j.operator_id=? AND j.compiled_body_digest=?
  AND j.project_id=? AND j.location=? AND j.job_id=? AND j.receipt_id=? AND j.cap=?`;

async function context({ db, tenantId, principalId }: ControlAccess, audience: string, intentId: string) {
  const { row, identity } = await loadDelegatedClaimSnapshot(db, [tenantId, intentId, audience, principalId]);
  return { db, jobReference: identity.jobReference, witness: { audience, claimBodyDigest: row.compiled_body_digest },
    args: [tenantId, intentId, audience, principalId, row.compiled_body_digest, row.project_id, row.location, row.job_id, row.receipt_id, row.cap] };
}

async function readState(ctx: Awaited<ReturnType<typeof context>>) {
  const row = await ctx.db.prepare(`SELECT r.requested_by,r.requested_at,s.intent_id AS settled,
    ${terminalOutcomesConflict("j")} AS conflict,
    (r.job_id=j.job_id AND r.delegation_audience=j.audience AND r.claim_body_digest=j.compiled_body_digest) AS verified,
    (SELECT o.outcome FROM bigquery_terminal_observations o WHERE o.tenant_id=j.tenant_id AND o.intent_id=j.intent_id LIMIT 1) AS outcome
    FROM recoverable_delegated_jobs j
    LEFT JOIN bigquery_cancellation_requests r ON r.tenant_id=j.tenant_id AND r.intent_id=j.intent_id
    LEFT JOIN cost_settlements s ON s.tenant_id=j.tenant_id AND s.intent_id=j.intent_id
    WHERE ${pinned}`).bind(...ctx.args)
    .first<{ requested_by: string | null; requested_at: string | null; verified: number | null; settled: string | null;
      conflict: number; outcome: "succeeded" | "failed" | "cancelled" | null }>();
  if (!row) throw new Error("Delegated cancellation scope unavailable");
  if (row.conflict) throw new Error("Conflicting terminal outcomes");
  const request = row.requested_by === null ? null : {
    requestedBy: row.requested_by, requestedAt: row.requested_at, verified: row.verified === 1
  };
  const result = { jobReference: ctx.jobReference, witness: ctx.witness, request };
  if (row.outcome !== null) return { ...result, state: "terminal" as const, outcome: row.outcome };
  if (row.settled !== null) return { ...result, state: "settled-unverified" as const };
  if (request) return { ...result, state: request.verified ? "requested" as const : "unverified-request" as const };
  return { ...result, state: "not-requested" as const };
}

export async function readDelegatedCancellation(access: ControlAccess, audience: string, intentId: string) {
  return readState(await context(access, audience, intentId));
}

// Owner recovery follows the claimed job, even after the original grant expires.
// It does not authorize a new execution or reattribute a historical request.
export async function requestDelegatedCancellation(access: ControlAccess, audience: string, intentId: string) {
  const ctx = await context(access, audience, intentId), initial = await readState(ctx);
  if (initial.state !== "not-requested") return initial;
  const write = await ctx.db.prepare(`INSERT INTO bigquery_cancellation_requests
    (tenant_id,intent_id,job_id,requested_by,delegation_audience,claim_body_digest)
    SELECT j.tenant_id,j.intent_id,j.job_id,j.operator_id,j.audience,j.compiled_body_digest
    FROM recoverable_delegated_jobs j WHERE ${pinned} AND NOT ${terminalOutcomesConflict("j")}`)
    .bind(...ctx.args).run();
  if (!write.success) throw new Error("Delegated cancellation write not confirmed");
  const saved = await readState(ctx);
  if (saved.state === "not-requested") throw new Error("Delegated cancellation write not confirmed");
  return saved;
}
