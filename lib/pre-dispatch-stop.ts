import { isControlTimestamp } from "./control-objects";
import type { ControlAccess } from "./control-storage";

// Internal only. This stops local handoff; it neither cancels a warehouse job
// nor resolves the reservation. Access comes from authenticated server context.
export async function stopBeforeDispatch(access: ControlAccess, intentId: string) {
  const { db, tenantId, principalId } = access;
  const write = await db.prepare(`INSERT INTO dispatch_stopped_intents
    (tenant_id,intent_id,reason,stopped_by,stopped_at)
    VALUES(?,?,'owner_requested_stop',?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
    .bind(tenantId, intentId, principalId).run();
  if (!write.success) throw new Error("Pre-dispatch stop write failed");
  // Zero changes can mean replay, a competing claim, or a historical marker.
  // Use persisted facts and recheck owner access, even when this call wrote nothing.
  const row = await db.prepare(`SELECT c.intent_id AS claimed,s.intent_id AS settled,
      t.intent_id AS stopped,t.stopped_by AS actor,t.stopped_at AS at
    FROM execution_intents i
    JOIN control_memberships m ON m.tenant_id=i.tenant_id AND m.principal_id=? AND m.active=1 AND m.role='owner'
    LEFT JOIN dispatch_claims c ON c.tenant_id=i.tenant_id AND c.intent_id=i.id
    LEFT JOIN cost_settlements s ON s.tenant_id=i.tenant_id AND s.intent_id=i.id
    LEFT JOIN dispatch_stopped_intents t ON t.tenant_id=i.tenant_id AND t.intent_id=i.id
    WHERE i.tenant_id=? AND i.id=?`)
    .bind(principalId, tenantId, intentId).first<{ claimed: string | null; settled: string | null;
      stopped: string | null; actor: string | null; at: string | null }>();
  if (!row) throw new Error("Pre-dispatch stop unavailable");
  if (row.claimed !== null) return { state: "already-claimed" as const };
  if (row.settled !== null) return { state: "already-settled" as const };
  if (row.stopped === intentId) {
    if (row.actor === null && row.at === null) return { state: "legacy-stop" as const };
    if (row.actor && row.at && isControlTimestamp(row.at)) {
      return { state: "stopped" as const, stoppedBy: row.actor, stoppedAt: row.at };
    }
  }
  throw new Error("Pre-dispatch stop unavailable");
}
