# Database adapter inspection

This repository currently implements a governed BigQuery metric-read transport.
PostgreSQL has a separate [governed Node host integration](POSTGRESQL_CONNECTOR.md)
with persisted session authority, scoped requester/owner-approved Agent signatures,
attempt quotas, durable unresolved-read concurrency limits, append-only
acknowledged-failure receipts, authorized active-query cancellation and REST/MCP hooks.
It has an independent Node build (`npm run postgresql:build`), shared local
execution/preparation admission, and exact integer-width, decimal, boolean, text,
UUID and temporal equality parameters with built-in OID validation. Results remain
single numeric aggregates; this is not arbitrary SQL or general row extraction.
An optional Node 24.22.1 `node:sqlite` control binding opens an already authorized,
initialized local ledger with schema validation, atomic batches and bounded waits;
it never initializes a production database or adds SQLite business-query support.
An optional bounded loopback HTTP service forwards the same authenticated commands,
retains admission during uncertain shutdown and requires a separately approved TLS
proxy; it does not provision public routes, OAuth or MCP session initialization.
Cancellation intent is not terminal proof; an unavailable executor leaves it pending.
Host-process crash recovery is tested without automatic replay. It is not deployed in the production
Worker and does not offer monetary cost settlement or open-ended Agent grants. The inspector continues to reject it
as an unimplemented **Gateway adapter**. Other engines are not implemented. Internal D1
storage, ecosystem integrations and wire-protocol compatibility do not establish
business-query support. Provider verification and independent pilot acceptance
are not asserted by this inventory.

## Offline inspector

```sh
npm run adapters:build
npm run adapters:inspect -- --list
npm run adapters:inspect -- --request requirements.json
```

The request format is strict and versioned:

```json
{
  "schemaVersion": "adapter-read-requirements.v1",
  "engine": "bigquery",
  "action": "odap.metric-read.v1",
  "requireProviderVerification": false,
  "limits": [{ "unit": "billed-bytes", "maximum": 1048576 }]
}
```

Exit 0 means the requested capabilities match the local implementation inventory.
Exit 2 means incompatible or invalid requirements; inspect the reason codes.
Exit 1 means unreadable input or invalid CLI usage. Files must be UTF-8 JSON,
at most 64 KiB. Extra fields, unknown versions, duplicate resource units, empty
limits and non-positive/unsafe integer amounts are rejected. The tool never
accepts credentials, endpoints, SQL, or caller-supplied verification claims.

Every output includes `offlineAssessment: true` and `authorizationGranted: false`.
The inspector does not access a database, resolve credentials, reserve budget,
approve a contract, submit a job, or certify a deployed provider. Setting
`requireProviderVerification: true` currently rejects even BigQuery. For
execution, the existing authenticated dispatch path and all its gates remain
mandatory. Do not use this tool's exit code as execution authorization.

## Resource and currency units

Resource ceilings distinguish billed bytes, elapsed milliseconds, returned rows
and memory bytes. BigQuery's current inventory advertises only its query-level
billed-byte ceiling. It does not equate the HTTP deadline with a provider query
timeout, a returned-row limit with a scan limit, or a node memory limit with a
whole-query limit. Other requested resource guarantees fail closed.

`resourceCeiling` is a separate, offline arithmetic helper. It accepts a positive
safe-integer micro-USD reservation, an explicit linear price for the matching
resource unit, and a policy maximum. It floors the calculation using exact
integer intermediates and applies the tighter maximum. Unknown rates, zero
prices, incompatible units and amounts insufficient for one unit are rejected.
Prices are caller-supplied assumptions, not verified vendor prices. Optimizer
costs are not money. Capacity pricing and nonlinear billing need their own
reviewed model and cannot be inferred from this helper.

The existing BigQuery dispatch and budget ledger are unchanged. Equivalence
tests compare the new arithmetic with its current byte-ceiling implementation;
this is not evidence that another engine supports cost enforcement.

## Version and evidence scope

`adapter-inventory.v1`, `adapter-read-requirements.v1` and
`adapter-capability-assessment.v1` are local engineering formats, not additions
to the ODAP protocol. The BigQuery entry identifies its adapter revision,
provider interface and repository implementation/test paths. These paths are
review pointers, not signed verification evidence or deployed-version claims.

Inventory changes require implementation and regression evidence. Each future
engine must identify tested server/driver versions and deployment/catalog scope
before claiming live compatibility. An unimplemented engine cannot become
supported by merely changing a request or supplying a compatible driver.

## Internal submission interface

The existing owner and delegated BigQuery paths share a
[prepared-read submission boundary](READ_SUBMISSION_BOUNDARY.md). It orders
preparation, durable claim confirmation and a single send attempt. Authorization
and budget decisions remain in the existing host storage operations; the offline
inspector does not grant access to this interface. Shared SQLite conformance
tests cover both paths without claiming a second database implementation.
