# Offline OpenLineage export

Experimental community integration, maintained in ODAP Gateway, not an
OpenLineage core facet or an endorsed integration. It converts an independently
pinned settled-evidence bundle into a historical Gateway attempt cycle using
OpenLineage 2.0.2 and the namespaced `odap_evidence` custom run facet.

## Run

```sh
npm ci
npm run evidence:build
node dist/evidence/scripts/export-openlineage.js \
  tests/fixtures/settled-job.json t i tests/pins/settled-job.sha256 \
  https://gateway.example/gateway
```

The example uses synthetic data. Output is exactly two NDJSON lines. Use the
Node command directly when piping output; npm can add its own script banners.
Arguments are bundle, expected tenant, expected intent, independently retained
SHA-256 pin file, and deployment namespace. An optional `--audience <expected>`
requires matching delegated evidence; it cannot confer delegation on a local
bundle. HTTPS and URN deployment namespaces are supported; credentials, query
strings and fragments are rejected. Keep the namespace stable per deployment.

Validation finishes before any event is written. Invalid checksums, scope,
record links, chronology or terminal outcomes produce a nonzero exit and no
events. The exporter performs no network requests and does not read credentials,
execute queries, contact a collector or change a database. It can run from the
compiled `dist/evidence` directory without installed runtime packages.

## Semantics and limits

| Source | OpenLineage representation |
| --- | --- |
| Gateway claim timestamp | `START` for the Gateway attempt, not warehouse execution start |
| Recorded terminal observation timestamp | `COMPLETE`, `FAIL` or `ABORT` for succeeded, failed or cancelled |
| Local consistency check and retained digest | Terminal `run.facets.odap_evidence` |
| Logical contract target | Job name component, not a dataset |
| Unknown/pending/denied or inconsistent outcome | Rejected; no partial cycle |

Both events are reconstructed after settlement; `retrospective: true` and the
time-basis fields make this explicit. Billing/settlement time is not used as
warehouse completion time. Run duration therefore describes the recorded
Gateway claim-to-observation interval, not warehouse execution duration.

The source bundle contains no authoritative physical table identities.
`inputs` and `outputs` are omitted, not emitted as verified empty datasets.
This version does **not** provide table/column lineage, a parent-run link to an
existing BigQuery integration, or authenticated warehouse provenance.

The run ID is UUIDv5 (URL namespace) over the JSON array of the fixed domain
`odap.gateway.bigquery-attempt.v1`, normalized deployment namespace, tenant,
BigQuery project, location and job ID. It is stable across repeat exports and
billing corrections, not a signature. The retained pin must come from a trusted
independent channel; generating it from an untrusted bundle proves nothing.
`issuerAuthenticated` stays false. Historical consistency is neither current
authorization nor ODAP conformance certification.

Only allowlisted correlation fields are exported. SQL, parameters, result rows,
free-text reasons, principal/agent identities, billing references and amounts
are not copied. Tenant, logical target and correlation IDs are still metadata:
review them before sharing events with a third-party collector.

Caller-owned transport must preserve START-before-terminal order and handle
duplicate exports. Do not mix this retrospective cycle with live events for the
same run or assume exactly-once ingestion. No collector acceptance, rendering,
retention or UI support is claimed by schema validation alone.

## DataHub receiver notes

Source review of DataHub commit
[`1415bedd277cf61c15b0c08b0c0db3ada69cb450`](https://github.com/datahub-project/datahub/blob/1415bedd277cf61c15b0c08b0c0db3ada69cb450/metadata-integration/java/openlineage-converter/src/main/java/io/datahubproject/openlineage/converter/OpenLineageToDataHub.java)
identifies these prerequisites and limitations, **not a receiver integration test**:

- Configure `DATAHUB_OPENLINEAGE_ORCHESTRATOR=odap-gateway` on a receiver used for
  these events. This exporter does not provide `processing_engine`; the default
  producer-URL inference does not recognize its ODAP producer URL.
- The converter's custom-property switch does not recognize `odap_evidence`.
  Do not assume the digest, trust flags or correlation fields survive ingestion.
  A separate, reviewed mapping is needed to preserve this evidence association.
- `FAIL` and `ABORT` both become a completed process with `FAILURE`, while
  `nativeResultType` retains their distinct original value. Keep cancellation
  separate when interpreting the result; neither means successful execution.

No DataHub endpoint was contacted, and duplicate/out-of-order event behavior,
evidence retention and UI rendering remain unverified. These notes do not
request a core schema change or add an automatic emitter.

## Tests and schema provenance

```sh
npm run test -- tests/openlineage-export.test.ts tests/openlineage-cli.test.ts
```

Tests validate events and the custom facet separately using JSON Schema
2020-12, reject trust escalation/unknown fields, check terminal mappings,
stable UUID identity, scope/checksum rejection and detached CLI behavior.

`tests/fixtures/openlineage-2-0-2.schema.json` is an unmodified copy of
[OpenLineage's 2.0.2 schema](https://openlineage.io/spec/2-0-2/OpenLineage.json),
from the Apache-2.0-licensed [OpenLineage project](https://github.com/OpenLineage/OpenLineage).
SHA-256: `69f68bee00b9beac88a87059c0102410e7bb05f3f43c46d02a0409831eceb0d2`.
The custom schema URL is pinned to the `openlineage-evidence-v0.1.0` release tag;
future incompatible or compatible schema changes require a new version URL.
See the [custom facet guidance](https://openlineage.io/docs/spec/facets/custom-facets/)
and [run-cycle semantics](https://openlineage.io/docs/spec/run-cycle/).
