# OpenMetadata / Collate evidence status adapter

ODAP-maintained preview using `openmetadata-ingestion==2.0.8.0`. It stages official
OpenMetadata SDK models; it does not claim Collate Cloud compatibility, an
upstream contribution, or acceptance by a live server.

Build and configure `AttemptReader` from the [Python package](../python/README.md).
Install `./integrations/python[openmetadata]`. Inside an async host function:

```python
from odap_integrations.openmetadata import prepare_pipeline_statuses

proposals = await prepare_pipeline_statuses(
    reader, [('sample', 'example-correlation')],
    targets={
        ('https://gateway.example/gateway', 'odap/tenant/t/target/orders'):
            'odap_gateway.orders',
    },
)
wire_status = proposals[0].status.model_dump_json(exclude_none=True)
target_fqn = proposals[0].pipeline_fqn
```

The example FQN is synthetic. A host must explicitly map each exact
deployment/job pair to a permitted, already-existing pipeline representing
**ODAP recorded attempt history**, not silently overwrite an unrelated
orchestrator pipeline's status. No pipeline/service creation, inferred entity
discovery, credential configuration or server write occurs.

The SDK's `timestamp` is a per-pipeline history key, expressed in milliseconds.
This adapter uses the Gateway claim time as that key and the recorded run UUID
as `executionId`. Within a bounded batch of 1-100 selections, identical replays
deduplicate; different evidence under the same `(pipeline FQN, timestamp)`
rejects the whole batch with `catalog_run_collision`. No shifted timestamps or
silent overwrites are generated. This is **not cross-batch/server conflict
detection**. Before any later delivery, the host must check existing history
and concurrency, define correction policy and handle partial writes. Do not
blindly resend a changed snapshot at an occupied history key.

Success maps to Successful, failure and cancellation to Failed because the
SDK has no cancelled status. Parameters preserve the original outcome and
explicit `cancelled-as-failure` projection, evidence digest, snapshot/run IDs,
Gateway time bases and false issuer/authorization flags. Use these parameters
when interpreting failure alerts. No task execution, warehouse wall-clock
`endTime`, datasets, SQL, user identity or row/cost metrics are invented.

The source pin, tenant, intent and optional audience are verified first. A
locally consistent bundle does not authenticate its issuer or grant query
permission. Catalog visibility must protect even the allowlisted operational
identifiers. Tests cover actual SDK roundtrips, three outcomes, exact target
binding, collisions/replay, bounded batches and invalid-pin refusal. They do
not establish live receiver persistence, authentication or a joint pilot.

References: official [pipeline schema](https://github.com/open-metadata/OpenMetadata/blob/d4c91910b1ad0c91fb23e2b9cf020d43d677f4c1/openmetadata-spec/src/main/resources/json/schema/entity/data/pipeline.json)
and [timestamp schema](https://github.com/open-metadata/OpenMetadata/blob/d4c91910b1ad0c91fb23e2b9cf020d43d677f4c1/openmetadata-spec/src/main/resources/json/schema/type/basic.json).
