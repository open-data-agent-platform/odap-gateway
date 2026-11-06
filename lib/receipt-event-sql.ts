// The receipt_created trigger records database insertion time, not the time
// claimed in the receipt payload. Count before matching: duplicates are ambiguous.
export function hasReceiptCreationEvent(receipt: "p" | "f") {
  return `(SELECT CASE WHEN COUNT(*)=1 THEN MAX(e.actor=${receipt}.created_by AND e.recorded_at=${receipt}.created_at)
    ELSE 0 END FROM control_object_events e
    WHERE e.tenant_id=${receipt}.tenant_id AND e.object_kind='receipt' AND e.object_id=${receipt}.id)`;
}
