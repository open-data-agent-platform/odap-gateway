# ODAP Gateway integrations

These are ODAP-maintained integrations, not upstream endorsements. Each entry
states what the code actually does. Installing an adapter does not configure
Gateway login, authorize a query, or complete a pilot.

| Integration | Implemented surface | Validation boundary |
| --- | --- | --- |
| [PostgreSQL](../docs/POSTGRESQL_CONNECTOR.md) | Governed Node HTTP/MCP host for released COUNT/SUM reads, approval, signed delegation, cancellation and local evidence | Synthetic real-engine CI on exact 15.20/16.16/17.12/18.7; no arbitrary SQL, public Worker route, production setup or independent pilot |
| [OpenLineage](openlineage/README.md) | Export pinned settled evidence as retrospective attempt events | Schema/client and pinned DataHub converter checks; native facet retention fails; no collector persistence or physical table lineage |
| [NVIDIA Auto Ontology](nvidia/README.md) | Stage pinned SQL attribute context and explicit local mapping for candidate review | Synthetic pinned-source checks; no live import or automatic approval |
| [Cube](cube/README.md) | Stage a selected REST metadata measure plus explicit local definition for candidate review | Offline selected-envelope, pin, CLI and local admission checks; no Cube query or live import |
| [dbt](dbt/README.md) | Stage a selected manifest v12 metric plus explicit local definition for candidate review | Offline selected-envelope, pin, CLI and local admission checks; no dbt invocation or MetricFlow translation |
| [DataHub](datahub/README.md) | Stage official SDK proposals for a pinned historical evidence snapshot | SDK wire roundtrips; no receiver write, dataset lineage or authenticated issuer |
| [OpenMetadata / Collate](openmetadata/README.md) | Stage official SDK statuses for explicitly mapped ODAP attempt histories | SDK roundtrips and within-batch collision rejection; no receiver write or Collate Cloud validation |
| [OpenTelemetry](opentelemetry/README.md) | Emit an allowlisted historical observation through a host-supplied logger | Real SDK in-memory export; no collector acceptance, fabricated spans or guaranteed delivery |
| [FastMCP](fastmcp/README.md) | Register the local evidence verifier as an MCP tool | Actual client/server tests; no public authenticated endpoint or query dispatch |
| [LangChain](langchain/README.md) | Async structured evidence-verification tool | Actual tool invocation; no LLM or hosted LangSmith call |
| [LangGraph](langgraph/README.md) | Model-free evidence ToolNode graph | Actual graph invocation, including tool error status; no agent planning benchmark |
| [LlamaIndex](llamaindex/README.md) | Async evidence tool with explicit error outputs | Actual tool invocation; no query engine, retrieval index or LLM call |

The four Python framework integrations share one [package](python/README.md)
and invoke the existing Gateway verifier. They do not implement a second
authorization system. IDs remain strings; failed evidence checks never become
successful evidence receipts. Local verification success is separate from the
recorded query outcome, which can still be `failed` or `cancelled`.

## Not implemented by these modules

Live Cube/dbt semantic imports, DataHub/OpenMetadata receiver acceptance,
ClickHouse/other warehouse execution, automatic event delivery, and hosted
framework authentication are not supplied here. The PostgreSQL host is separate
from the framework evidence tools and requires explicit authenticated host and
source configuration. Its local evidence profile does not automatically inherit
compatibility with the historical-evidence exporters listed above.
Existing OpenLineage DataHub source notes are supplemented by a
[released-converter probe](datahub/receiver-tests/README.md), not a GMS server
acceptance test. The separate DataHub SDK adapter does not validate the native
OpenLineage ingestion path or repair its custom-facet loss. A generic MCP
tool does not establish compatibility with every MCP product.

Keep independently retained pins and evidence in access-controlled storage.
Do not expose a shared registry of all tenants to a public MCP server. The host
must authenticate the caller and authorize each registry before making its tool
available. These modules do not bypass the Gateway's production gates.
