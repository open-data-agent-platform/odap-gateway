"""Emit a historical evidence observation through an explicitly supplied logger."""

import time

from opentelemetry._logs import Logger, LogRecord, SeverityNumber
from opentelemetry.context import Context
from opentelemetry.trace import INVALID_SPAN, set_span_in_context

from .attempts import AttemptReader
from .evidence import EvidenceError


async def emit_attempt_log(
    reader: AttemptReader,
    evidence_ref: str,
    correlation_id: str,
    *,
    logger: Logger,
) -> None:
    item = await reader.read(evidence_ref, correlation_id)
    timestamp = item.end_ms * 1_000_000
    if not 0 <= timestamp <= 2**64 - 1:
        raise EvidenceError("telemetry_timestamp_out_of_range")
    severity = {
        "succeeded": SeverityNumber.INFO,
        "failed": SeverityNumber.ERROR,
        "cancelled": SeverityNumber.WARN,
    }[item.outcome]
    logger.emit(
        LogRecord(
            timestamp=timestamp,
            observed_timestamp=time.time_ns(),
            context=set_span_in_context(INVALID_SPAN, Context()),
            severity_number=severity,
            severity_text=severity.name,
            body="ODAP retrospective evidence observation of a recorded attempt",
            event_name="odap.evidence.observed",
            attributes=item.attributes() | {"odap.correlation.id": item.correlation_id},
        )
    )
