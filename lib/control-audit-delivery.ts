import type { ControlAccess } from "./control-storage";

type DeliveryKey = Readonly<{ tenantId: string; consumerId: string; sequence: string }>;
type ControlEvent = DeliveryKey & Readonly<{ objectKind: string; objectId: string; actor: string; recordedAt: string }>;
type CursorRow = { previous: string | null; sequence: string | null; objectKind: string; objectId: string; actor: string; recordedAt: string };

// Internal, at-least-once delivery. The trusted sink must durably accept (or deduplicate)
// the event before returning its key. No request may supply a sink or an acknowledged sequence.
export async function deliverNextControlEvent({db, tenantId, principalId}: ControlAccess, consumerId: string,
  accept: (event: ControlEvent) => Promise<DeliveryKey>): Promise<"idle" | "acknowledged" | "cursor_changed"> {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(consumerId)) throw new Error("Invalid audit consumer");
  const row = await db.prepare(`SELECT CAST(p.sequence AS TEXT) AS previous,CAST(e.sequence AS TEXT) AS sequence,
      e.object_kind AS objectKind,e.object_id AS objectId,e.actor,e.recorded_at AS recordedAt
    FROM control_memberships m LEFT JOIN control_audit_checkpoints p ON p.tenant_id=m.tenant_id AND p.consumer_id=?
    LEFT JOIN control_object_events e ON e.sequence=CASE WHEN p.sequence IS NULL THEN
      (SELECT MIN(n.sequence) FROM control_object_events n WHERE n.tenant_id=m.tenant_id)
      ELSE (SELECT MIN(n.sequence) FROM control_object_events n WHERE n.tenant_id=m.tenant_id AND n.sequence>p.sequence) END
    WHERE m.tenant_id=? AND m.principal_id=? AND m.role='owner' AND m.active=1
      AND (p.sequence IS NULL OR EXISTS (SELECT 1 FROM control_object_events a WHERE a.sequence=p.sequence AND a.tenant_id=m.tenant_id))`)
    .bind(consumerId,tenantId,principalId).first<CursorRow>();
  if (!row) throw new Error("Audit stream unavailable");
  if (row.sequence === null) return "idle";
  const { sequence, previous, objectKind, objectId, actor, recordedAt } = row;
  const ack = await accept(Object.freeze({tenantId,consumerId,sequence,objectKind,objectId,actor,recordedAt}));
  if (!ack || ack.tenantId !== tenantId || ack.consumerId !== consumerId || ack.sequence !== sequence)
    throw new Error("Audit acceptance not confirmed");

  // Compare against the observed cursor; a slower worker cannot move a newer checkpoint.
  // The migration rechecks current ownership and the next tenant event inside the write.
  const write = previous === null
    ? await db.prepare(`INSERT INTO control_audit_checkpoints(tenant_id,consumer_id,sequence,acknowledged_by)
        SELECT ?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM control_audit_checkpoints WHERE tenant_id=? AND consumer_id=?)`)
      .bind(tenantId,consumerId,sequence,principalId,tenantId,consumerId).run()
    : await db.prepare(`UPDATE control_audit_checkpoints SET sequence=?,acknowledged_by=?
        WHERE tenant_id=? AND consumer_id=? AND sequence=?`)
      .bind(sequence,principalId,tenantId,consumerId,previous).run();
  if (!write.success || (write.meta?.changes !== 1 && write.meta?.changes !== 0)) throw new Error("Audit checkpoint not confirmed");
  return write.meta.changes === 1 ? "acknowledged" : "cursor_changed";
}
