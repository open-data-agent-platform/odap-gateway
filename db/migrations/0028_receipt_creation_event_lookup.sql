-- Scope receipt checks without scanning the audit history for each admission.
-- Non-unique: restored duplicates remain visible as evidence gaps.
CREATE INDEX receipt_creation_event_lookup ON control_object_events(tenant_id,object_id)
WHERE object_kind='receipt';
