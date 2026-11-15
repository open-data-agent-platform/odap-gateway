"""Stage SDK proposals for evidence snapshots, without a DataHub connection."""

import re

from datahub.emitter.mcp import MetadataChangeProposalWrapper
from datahub.metadata.schema_classes import (
    AuditStampClass,
    DataProcessInstancePropertiesClass,
    DataProcessInstanceRunEventClass,
    DataProcessInstanceRunResultClass,
)

from .attempts import AttemptReader


async def prepare_proposals(
    reader: AttemptReader,
    evidence_ref: str,
    correlation_id: str,
    *,
    reporter_urn: str,
    reported_at_ms: int,
) -> list[MetadataChangeProposalWrapper]:
    # This is the host's reporting identity, never an inferred evidence issuer.
    if not isinstance(reporter_urn, str) or not re.fullmatch(
        r"urn:li:corpuser:[A-Za-z0-9_.@-]{1,128}", reporter_urn, re.ASCII
    ):
        raise ValueError("Explicit DataHub reporter URN required")
    if type(reported_at_ms) is not int or not 0 <= reported_at_ms < 2**63:
        raise ValueError("Invalid reporting time")
    item = await reader.read(evidence_ref, correlation_id)
    urn = f"urn:li:dataProcessInstance:odap-evidence-{item.snapshot_id}"
    properties = {
        key: str(value).lower() if isinstance(value, bool) else str(value)
        for key, value in item.attributes().items()
    }
    properties["odap.status_projection"] = (
        "cancelled-as-failure" if item.outcome == "cancelled" else "exact"
    )
    aspects = [
        DataProcessInstancePropertiesClass(
            name="ODAP evidence snapshot of recorded attempt " + item.run_id,
            created=AuditStampClass(time=reported_at_ms, actor=reporter_urn),
            customProperties=properties,
        ),
        DataProcessInstanceRunEventClass(
            timestampMillis=item.start_ms,
            status="STARTED",
            messageId=item.snapshot_id + ":start",
        ),
        DataProcessInstanceRunEventClass(
            timestampMillis=item.end_ms,
            status="COMPLETE",
            messageId=item.snapshot_id + ":terminal",
            result=DataProcessInstanceRunResultClass(
                type="SUCCESS" if item.outcome == "succeeded" else "FAILURE",
                nativeResultType=item.outcome,
            ),
        ),
    ]
    return [
        MetadataChangeProposalWrapper(entityUrn=urn, aspect=aspect)
        for aspect in aspects
    ]
