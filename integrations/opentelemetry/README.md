# OpenTelemetry evidence observation adapter

ODAP-maintained preview using `opentelemetry-sdk==1.45.2`. Emits an allowlisted
historical observation, not a fabricated execution span or audit-storage receipt.

Build/configure `AttemptReader` from the [Python package](../python/README.md)
and install `./integrations/python[opentelemetry]`. A local in-memory example:

```python
from opentelemetry.sdk._logs import LoggerProvider
from opentelemetry.sdk._logs.export import InMemoryLogRecordExporter, SimpleLogRecordProcessor
from opentelemetry.sdk.resources import Resource
from odap_integrations.opentelemetry import emit_attempt_log

exporter = InMemoryLogRecordExporter()
provider = LoggerProvider(resource=Resource({}), shutdown_on_exit=False)
provider.add_log_record_processor(SimpleLogRecordProcessor(exporter))
try:
    await emit_attempt_log(reader, 'sample', 'example-correlation',
                           logger=provider.get_logger('odap.evidence'))
    records = exporter.get_finished_logs()
finally:
    provider.shutdown()
```

Run this inside an async host function. The adapter never installs a global
provider or reads an exporter endpoint from environment variables. The host
owns the supplied logger, resource identity, processors, transport and shutdown.
A logger configured by the host **can send data remotely**; verify authorization,
destination and data handling before supplying one. The example and tests only
use memory. `OTEL_SDK_DISABLED` and host sampling/limits can suppress output.

The built Gateway exporter verifies the independent pin, scope, links and
terminal evidence first. The log timestamp is the recorded Gateway terminal
observation in nanoseconds; observed timestamp is the current emission time.
Unsupported unsigned-64-bit timestamps reject before emission. INFO/WARN/ERROR
represent succeeded/cancelled/failed respectively, not verification failure.
Rejected evidence emits no observation. Exact original outcome and false
issuer/authorization flags remain in attributes; the correlation label stays a
string, including values larger than JavaScript's safe integer range.

An explicit invalid-span context prevents unrelated current requests from
becoming the log's trace/span identity. No spans, SQL, raw evidence, results,
actors, credentials or dataset lineage are emitted. Retrospective run/digest
identifiers are still operational metadata and require visibility controls.
Successful `emit` return is not proof of delivery: queues, drops, retries,
deduplication, retention and collector acceptance belong to the host. Replays
may emit another observation with the same snapshot ID; there is no outbox.

Tests use the actual SDK in-memory exporter, verify trace-context isolation,
nanosecond precision, severity mapping, no dropped allowlisted attributes and
rejected-evidence/overflow behavior. No live collector, warehouse or model is
contacted. This is not a current execution trace or independent acceptance.

References: official [logs API](https://opentelemetry.io/docs/specs/otel/logs/api/)
and [logs SDK](https://opentelemetry.io/docs/specs/otel/logs/sdk/).
