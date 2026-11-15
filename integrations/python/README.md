# Python evidence integrations

Preview 0.2.0. This independent, ODAP-maintained package provides local evidence
tools for FastMCP, LangChain, LangGraph and LlamaIndex, plus SDK projections for
DataHub, OpenMetadata and OpenTelemetry. No upstream contribution
or endorsement is implied. Python 3.11+ and the Gateway's supported Node runtime
are required; compatibility checks use Python 3.12.

## Build and install

From the Gateway checkout:

```sh
npm ci
npm run evidence:build
python -m pip install './integrations/python[fastmcp]'
```

Other extras are `langchain`, `langgraph`, `llamaindex`, `datahub`, `openmetadata`
and `opentelemetry`. The base package
uses only the Python standard library; extras import their official framework.
Select just the extras needed by the host. No package registry publication is
implied by this source-install command.

## Host-owned registry

```python
from pathlib import Path
from odap_integrations import EvidenceSource, EvidenceVerifier

root = Path.cwd()
verifier = EvidenceVerifier(
    root / 'dist/evidence/scripts/verify-settled-evidence.js',
    {'9007199254740993': EvidenceSource(
        root / 'tests/fixtures/settled-job.json',
        root / 'tests/pins/settled-job.sha256',
        tenant_id='t', intent_id='i',
    )},
)
```

These paths refer only to the repository's synthetic fixture. In an application,
the host must first authenticate the caller and authorize the artifacts it puts
in that caller's registry. An evidence reference is a lookup key, not an access
token. No global registry, file discovery, credentials, or login fallback is
provided. Agents cannot supply a path, executable, pin, tenant or audience.
Configure the optional `audience` on `EvidenceSource` for delegated evidence.
The pin must be independently trusted; computing it from an untrusted bundle
and immediately trusting it establishes nothing.

```python
result = await verifier.verify('9007199254740993', '9223372036854775807')
```

The output has `status: verified` for a successful consistency check, not a
successful query. `recordedOutcome` preserves `succeeded`, `failed` or
`cancelled`. `issuerAuthenticated`, `executionAuthorized`, `providerContacted`
and `gatewayContacted` remain false. `actualMicroUsd` is a decimal string of
the recorded SQL charge, not a complete workflow bill or current cost estimate.
Correlation IDs are caller-supplied labels, not authenticated actor identities.

The compiled verifier is trusted host code. Its existing canonicalization,
cross-link, chronology, scope, terminal-state and independent-pin checks remain
authoritative. The adapter returns allowlisted summary fields, not SQL, raw
evidence, actor details or paths. Install/build artifacts and file storage must
remain controlled by the host.

## Failures and cancellation

Missing registry entries, invalid inputs, rejected evidence, malformed output
and timeouts raise a sanitized `EvidenceError` in the base API. FastMCP sets
the tool error bit, LangChain raises `ToolException`, LangGraph produces an
error ToolMessage, and LlamaIndex returns `ToolOutput(is_error=True)`.
Never set a framework's error handler to fabricate a successful receipt.

Timeout includes waiting for the bounded process slot. Cancelling a base API
call reaps its local verifier process and propagates cancellation. It does not
cancel any warehouse job. HTTP clients may abandon a tool call while the server
continues verification; configure server resource limits and do not infer remote
cancellation from a disconnected client. No retries or execution are performed.

Child output is bounded, shell execution is not used, and credential/proxy/model
environment variables and `NODE_OPTIONS` are not inherited. Node is resolved
once at construction; supply an explicit trusted executable if required.

## Validate

The four framework extras and three catalog/telemetry extras have separate test
environments. Combining all seven extras in one environment is not a verified
compatibility claim; upstream dependencies can impose different versions.

```sh
python -m pip install -r integrations/python/requirements-test.lock
python -m pip install --no-deps ./integrations/python
python -m pip check
python -m ruff check integrations/python/src integrations/python/tests
python -m mypy --ignore-missing-imports --follow-imports=silent --check-untyped-defs integrations/python/src
python integrations/python/tests/run_tests.py --report integration-results.json
```

Set `NO_PROXY=127.0.0.1,localhost` when local requests would otherwise use a
proxy. The suite uses the real built verifier and framework packages, a
synthetic fixture, and loopback HTTP. It does not call an LLM, a warehouse,
LangSmith, or a production Gateway, and is not independent acceptance.

## Catalog and telemetry evidence reader

The three new adapters use `AttemptReader` with the built
`dist/evidence/scripts/export-openlineage.js`, not the framework summary CLI:

```python
from pathlib import Path
from odap_integrations import EvidenceSource
from odap_integrations.attempts import AttemptReader

root = Path.cwd()
reader = AttemptReader(
    root / 'dist/evidence/scripts/export-openlineage.js',
    {'sample': EvidenceSource(
        root / 'tests/fixtures/settled-job.json',
        root / 'tests/pins/settled-job.sha256', 't', 'i',
    )},
    namespace='https://gateway.example/gateway',
)
attempt = await reader.read('sample', 'example-correlation')
```

The canonical deployment namespace is host configuration, not a receiver URL.
The same trusted exporter validates bundle/pin/scope before emitting anything.
The Python reader checks the exact event-pair envelope, outcome, timestamps and
allowlisted evidence facet. It rejects unexpected fields and duplicate JSON
keys. It shares bounded output, concurrency, sanitized errors and process
cancellation with the framework verifier, but is not a framework verifier API.

`AttemptEvidence` is immutable; its snapshot UUID binds deployment, recorded run
ID and evidence digest. It identifies a view of historical evidence, not a new
query. A revised digest gets a different snapshot UUID while the run ID remains
unchanged. No issuer authentication or execution authority is granted. The
times are Gateway claim/terminal-observation times, not warehouse execution
times. Correlation labels are not authenticated users and are only emitted to
the explicitly supplied telemetry logger, not catalog state.

In a separate Python 3.12 environment:

```sh
python -m pip install -r integrations/python/requirements-catalog-test.lock
python -m pip install --no-deps ./integrations/python
python -m pip check
python -m ruff check integrations/python/src integrations/python/catalog_tests
python -m mypy --ignore-missing-imports --follow-imports=silent --check-untyped-defs integrations/python/src
python integrations/python/catalog_tests/run_tests.py --report catalog-results.json
```

These tests use real SDK models and an in-memory log exporter. There is no
DataHub/OpenMetadata server, collector, service account, dataset mapping or live
pilot. See each adapter's README for lossy status mappings and delivery limits.
