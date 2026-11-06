import type { BigQueryEnv } from "./bigquery";
import { observeIntentJob } from "./bigquery-job-recovery";
import { readPreparedJob } from "./bigquery-job-storage";
import type { ControlAccess } from "./control-storage";
import { terminalOutcomesConflict } from "./terminal-outcome-sql";

type TerminalObservation = {
  state: "succeeded" | "failed" | "cancelled";
  billedBytes: number | null;
  observedAt: string;
  observedBy: string;
};

// No warehouse access: restart recovery can read the strongest durable sample.
export async function readTerminalObservation(access: ControlAccess, intentId: string) {
  const row = await access.db.prepare(`SELECT ${terminalOutcomesConflict("o")} AS conflict,o.outcome AS state,o.billed_bytes AS billedBytes,
      o.observed_at AS observedAt,o.observed_by AS observedBy
    FROM bigquery_terminal_observations o JOIN control_memberships m ON m.tenant_id=o.tenant_id
    WHERE o.tenant_id=? AND o.intent_id=? AND m.principal_id=? AND m.active=1 AND m.role='owner'
    ORDER BY o.has_bytes DESC LIMIT 1`)
    .bind(access.tenantId, intentId, access.principalId).first<TerminalObservation & { conflict: number }>();
  if (!row) return null;
  const { conflict, ...observation } = row;
  if (conflict) throw new Error("Conflicting terminal outcomes");
  return observation;
}

// Internal reconciliation only. Never accepts caller-supplied job evidence.
export async function reconcileTerminalObservation(access: ControlAccess, intentId: string, env: BigQueryEnv) {
  const { binding } = await readPreparedJob(access, intentId);
  const claim = await access.db.prepare(`SELECT c.maximum_bytes_billed AS cap FROM dispatch_claims c
    JOIN control_memberships m ON m.tenant_id=c.tenant_id
    WHERE c.tenant_id=? AND c.intent_id=? AND m.principal_id=? AND m.active=1 AND m.role='owner'
      AND c.maximum_bytes_billed IS NOT NULL`)
    .bind(access.tenantId, intentId, access.principalId).first<{ cap: number }>();
  if (!claim) throw new Error("Bounded dispatch claim unavailable");

  const sample = await observeIntentJob(env, binding, claim.cap);
  if (!("billedBytes" in sample)) return readTerminalObservation(access, intentId);
  const write = await access.db.prepare(`INSERT INTO bigquery_terminal_observations
    (tenant_id,intent_id,outcome,billed_bytes,has_bytes,observed_by) VALUES(?,?,?,?,?,?)`)
    .bind(access.tenantId, intentId, sample.state, sample.billedBytes,
      sample.billedBytes === null ? 0 : 1, access.principalId).run();
  if (!write.success) throw new Error("Terminal observation write failed");
  const saved = await readTerminalObservation(access, intentId);
  if (!saved) throw new Error("Terminal observation unavailable");
  return saved;
}
