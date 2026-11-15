# DataHub evidence snapshot adapter

ODAP-maintained preview using `acryl-datahub==1.7.0.20`. This is an offline SDK
proposal adapter, not an upstream endorsement or DataHub receiver acceptance.

Build the detached exporter and configure the host-scoped `AttemptReader` as in
the [Python package](../python/README.md). Install `./integrations/python[datahub]`.
Then, inside an async host function:

```python
from odap_integrations.datahub import prepare_proposals

proposals = await prepare_proposals(
    reader, 'sample', 'example-correlation',
    reporter_urn='urn:li:corpuser:odap-reporter',
    reported_at_ms=1767225700000,
)
wire_proposals = [proposal.to_obj() for proposal in proposals]
```

The reporter and reporting time above are synthetic host inputs. Supply a
permitted reporting identity and real reporting time in an application. Neither
authenticates the original evidence issuer. Retain the same reporting inputs on
retry if byte-stable proposals are required.

The function first checks the independent pin, tenant, intent and optional
audience through the existing Gateway exporter, then returns three official
`MetadataChangeProposalWrapper` objects: evidence-snapshot properties and a
retrospective STARTED/COMPLETE pair. The `dataProcessInstance` URN is scoped to
the snapshot digest; it is explicitly named as evidence, not a new warehouse
execution or an inferred DataJob. Revisions preserve the recorded run ID but
use a different snapshot URN. Stable message IDs identify each phase. This
does not prove receiver idempotency or atomic ingestion of the three proposals.

The SDK lacks a cancelled result. Success maps to SUCCESS; failure and
cancellation map conservatively to FAILURE. `nativeResultType` and
`odap.recorded_outcome` preserve the exact original outcome; cancellation also
sets `odap.status_projection=cancelled-as-failure`. Consumers must inspect these
fields before alerting or deriving failure rates. COMPLETE means a terminal
record, not success. STARTED is based on the Gateway claim, and COMPLETE on the
terminal observation; neither asserts warehouse start/end times. No duration,
dataset lineage, SQL, result rows, actor identity or billing amount is inferred.

Allowlisted custom properties retain digest/receipt/contract/release/run IDs,
time bases and explicit false issuer/authorization flags. These are still
potentially sensitive operational identifiers; authorize catalog visibility.
No RestEmitter, connection, credentials, entity creation call, automatic retry
or network delivery is configured. The host must separately review proposals,
authorize the target, configure delivery, handle partial writes and retention,
and establish receiver compatibility. Existing [OpenLineage receiver notes](../openlineage/README.md)
are not validated by this independent SDK path.

Tests exercise all three outcomes, real SDK serialization roundtrips, stable
replay, revision isolation and rejection of invalid evidence/reporting inputs.
They do not authenticate an issuer or prove a live DataHub server accepted data.

References: official [DataProcessInstance model](https://archive.docs.datahub.com/docs/1.7.0/generated/metamodel/entities/dataprocessinstance)
and [Python models](https://archive.docs.datahub.com/docs/1.7.0/python-sdk/models).
