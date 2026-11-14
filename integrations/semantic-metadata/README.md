# Offline semantic metadata intake

This ODAP-maintained preview accepts a bounded Cube REST `/v1/meta` snapshot or
a dbt `manifest.json` v12 snapshot, plus an explicit local metric definition.
It stages a pinned review bundle and can admit it through the existing Gateway
candidate workflow. It does not contact either product, execute SQL, translate
metrics, approve a candidate or publish a release.

## Stage a bundle

From the Gateway checkout, with dependencies installed (including the pinned
`jsonc-parser` runtime dependency):

```sh
node node_modules/typescript/bin/tsc -p scripts/tsconfig.semantic-metadata-import.json
node dist/semantic-metadata-import/scripts/stage-semantic-metadata-import.js metadata.json mapping.json new-bundle.json
```

The command refuses existing output paths, non-regular inputs, invalid UTF-8,
BOM, malformed JSON, duplicate object keys (including escaped equivalents),
comments, trailing commas, non-finite numbers and nesting beyond 64 containers.
Source input is limited to 8 MiB;
mapping input to 48 KiB. It prints only `status: staged-only` and the complete
evidence digest. It does not read credentials or make network/database calls.
Keep the digest independently from the bundle. A self-generated hash does not
authenticate the exporting system.

An illustrative, synthetic Cube mapping is:

```json
{
  "sourceFormat": "cube.rest-meta.v1",
  "sourceVersion": "0.0.0-synthetic",
  "sourceInstance": "synthetic-offline",
  "containerId": "orders",
  "resourceId": "orders.net_revenue",
  "capturedAt": "2026-11-14T00:00:00.000Z",
  "tenantId": "t",
  "revisionId": "cube-revision",
  "ownerId": "owner",
  "definition": {
    "profile": "odap.bigquery-metric.v1",
    "tenantId": "t",
    "sourceRevision": "s1",
    "target": "orders",
    "metricId": "revenue",
    "table": { "project": "demo-project", "dataset": "analytics", "name": "orders" },
    "measure": { "aggregate": "SUM", "column": "net_amount" },
    "filters": { "year": { "column": "order_year", "type": "INT64" } }
  }
}
```

For dbt, use `sourceFormat: dbt.manifest.v12`, set `containerId` to the package
name and `resourceId` to the metric's exact `unique_id`. `sourceVersion` must
match `metadata.dbt_version`. Supply the actual asserted version when handling
an authorized export; the example's version is deliberately synthetic.

`sourceInstance`, capture time and version are operator assertions, not fetched
or authenticated facts. Cube's metadata response does not independently carry
the server version; its version assertion is pinned but cannot be verified here.
Tenant, revision, local owner and definition are explicit local decisions.
Upstream owner IDs, certification, public flags, tags and descriptions never
become local permissions or approval. The mapped definition is not inferred
from SQL, aggregation hints, dbt expressions, dependencies or MetricFlow plans.

## Review and admission

`prepareSemanticMetadataImport(sourceJson, mappingJson)` retains the exact raw
snapshot, its digest, selected resource identity and the complete mapping.
`verifySemanticMetadataImport(bundleJson, independentlyRetainedDigest)` rebuilds
the bundle and rejects changes to any of those or to its candidate proposal.
Store the bundle in access-controlled storage; snapshots may contain SQL or
private metadata. Do not commit real exports, bundles or credentials to Git.

Trusted host code can call
`recordSemanticMetadataProposal(authenticatedControlAccess, bundleJson, pin)`.
It checks the local tenant before storage, then uses the existing candidate
insert, which rechecks active local reviewer/owner membership and the named
owner. Reusing a revision ID cannot overwrite an existing candidate. Storage
keeps the candidate definition and provenance reference, not the raw snapshot.

No validation, approval, release, grant, budget, query, bill or receipt is
created by staging. Admission creates only a candidate. Business equivalence,
units, filters, time grain, joins, source freshness and permitted execution
remain subject to the existing review, compiler and policy gates.

## Validation boundary

This is selected-resource envelope validation, not complete upstream JSON
Schema validation. It supports only the source shapes described in the
[Cube](../cube/README.md) and [dbt](../dbt/README.md) pages. Unknown source
formats, missing/ambiguous identities and incompatible selected fields fail
closed. Tests cover synthetic context, local SQLite admission and actual CLI
invocation. They do not establish live upstream interoperability, independent
acceptance, endorsement, hosted authentication or a real pilot.

Source: [`lib/semantic-metadata-import.ts`](../../lib/semantic-metadata-import.ts).
No Worker/frontend endpoint, production migration or deployment is included.
