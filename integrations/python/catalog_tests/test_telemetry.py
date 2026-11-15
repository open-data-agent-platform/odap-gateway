import dataclasses
import unittest
from unittest.mock import AsyncMock, patch

from odap_integrations import EvidenceError
from odap_integrations.opentelemetry import emit_attempt_log
from opentelemetry import trace
from opentelemetry._logs import SeverityNumber
from opentelemetry.sdk._logs import LoggerProvider
from opentelemetry.sdk._logs.export import (
    InMemoryLogRecordExporter,
    SimpleLogRecordProcessor,
)
from opentelemetry.sdk.resources import Resource
from test_attempts import reader


class TelemetryTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.exporter = InMemoryLogRecordExporter()
        self.provider = LoggerProvider(resource=Resource({}), shutdown_on_exit=False)
        self.provider.add_log_record_processor(SimpleLogRecordProcessor(self.exporter))
        self.logger = self.provider.get_logger("odap.evidence")

    def tearDown(self):
        self.provider.shutdown()

    async def test_real_sdk_log_has_exact_times_and_no_ambient_span(self):
        span = trace.NonRecordingSpan(
            trace.SpanContext(
                trace_id=123,
                span_id=456,
                is_remote=False,
                trace_flags=trace.TraceFlags(1),
            )
        )
        with (
            trace.use_span(span),
            patch(
                "socket.socket.connect", side_effect=AssertionError("Network forbidden")
            ),
        ):
            await emit_attempt_log(
                reader(), "ref", "9007199254740993", logger=self.logger
            )
        logs = self.exporter.get_finished_logs()
        self.assertEqual(len(logs), 1)
        record = logs[0].log_record
        self.assertEqual(record.timestamp, 1767225602000000000)
        self.assertGreater(record.observed_timestamp, record.timestamp)
        self.assertEqual(record.trace_id, 0)
        self.assertEqual(record.span_id, 0)
        self.assertEqual(record.severity_number, SeverityNumber.WARN)
        self.assertEqual(record.attributes["odap.correlation.id"], "9007199254740993")
        self.assertIs(record.attributes["odap.issuer_authenticated"], False)
        self.assertEqual(record.attributes["odap.start_time_basis"], "gateway-claim")
        self.assertEqual(logs[0].dropped_attributes, 0)

    async def test_failure_emits_nothing(self):
        with self.assertRaises(EvidenceError):
            await emit_attempt_log(reader(), "missing", "c", logger=self.logger)
        self.assertEqual(len(self.exporter.get_finished_logs()), 0)

    async def test_severity_and_nanosecond_overflow(self):
        service = reader()
        item = await service.read("ref", "c")
        for outcome, severity in (
            ("succeeded", SeverityNumber.INFO),
            ("failed", SeverityNumber.ERROR),
        ):
            with patch.object(
                service,
                "read",
                AsyncMock(return_value=dataclasses.replace(item, outcome=outcome)),
            ):
                await emit_attempt_log(service, "ref", "c", logger=self.logger)
            self.assertEqual(
                self.exporter.get_finished_logs()[-1].log_record.severity_number,
                severity,
            )
        with patch.object(
            service,
            "read",
            AsyncMock(return_value=dataclasses.replace(item, end_ms=253402300799999)),
        ), self.assertRaisesRegex(
            EvidenceError, "telemetry_timestamp_out_of_range"
        ):
            await emit_attempt_log(service, "ref", "c", logger=self.logger)
        self.assertEqual(len(self.exporter.get_finished_logs()), 2)
