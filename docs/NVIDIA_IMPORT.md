# Offline NVIDIA Semantic Import

This experimental adapter stages one NVIDIA Auto Ontology SQL attribute for
Gateway candidate review. It does not connect to NVIDIA, translate arbitrary
SQL, execute a query, publish a release, or certify business correctness.
There is no public import endpoint or production import UI in this delivery.

## Pinned Upstream Boundary

The supported source is the JSON response from `GET /sql-attributes/{attr_id}`
at NVIDIA Auto Ontology commit
`c447003f72a822301e927196a4ecb5b597c308d5`. Other commit values are rejected;
upgrades require compatibility review and new fixtures, not a moving `main` pin.

Primary references at that commit:

- [SQL attribute model](https://github.com/NVIDIA/auto-ontology/blob/c447003f72a822301e927196a4ecb5b597c308d5/auto_ontology/server/models.py)
- [Read and edit endpoints](https://github.com/NVIDIA/auto-ontology/blob/c447003f72a822301e927196a4ecb5b597c308d5/auto_ontology/server/sql_attributes/router.py)
- [Persistence and certification fields](https://github.com/NVIDIA/auto-ontology/blob/c447003f72a822301e927196a4ecb5b597c308d5/auto_ontology/dal/sql_attributes.py)
- [Model interchange schema](https://github.com/NVIDIA/auto-ontology/blob/c447003f72a822301e927196a4ecb5b597c308d5/auto_ontology/server/model_interchange/schemas.py)

The YAML model interchange does not carry SQL attribute certification. This
adapter deliberately uses the detail-response envelope instead. A `certified`
boolean maps to `upstream-certified` or `upstream-uncertified`; null or absent
maps to `upstream-unknown`. Strings and numbers are not coerced to booleans.
All three states remain **unverified upstream claims**, never Gateway approval.

The compatibility fixture in `tests/fixtures/nvidia-sql-attribute.json` was
authored synthetically against these fields. It is not a real upstream export,
an independent integration, or evidence of NVIDIA certifying a metric. No
upstream implementation code or business data is bundled.

## Stage Locally

Use the project's supported Node runtime and installed TypeScript compiler:

```sh
node node_modules/typescript/bin/tsc -p scripts/tsconfig.nvidia-import.json
node dist/nvidia-import/scripts/stage-nvidia-import.js response.json mapping.json new-bundle.json
```

The operator must obtain an authorized export separately. Do not put bearer
tokens, cookies, connection strings, business data or private exports in Git.
The command performs no network access, credential loading or database writes.
It refuses an existing output path and prints only the new evidence digest.
Keep that digest separately from the bundle for later verification.

`mapping.json` contains these explicit local decisions:

```json
{
  "upstreamCommit": "c447003f72a822301e927196a4ecb5b597c308d5",
  "sourceInstance": "synthetic-offline-instance",
  "attributeId": "synthetic-attribute-revenue",
  "capturedAt": "2026-11-07T00:00:00.000Z",
  "tenantId": "t",
  "revisionId": "nvidia-revision",
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

`sourceInstance` is an operator label, not a fetched URL. Capture time, instance,
commit and source ID are operator assertions, not authenticated attestations.
The adapter retains exact original response text (including descriptive
metadata, owner, zones, tags and timestamps) and its SHA-256 digest. A second
digest binds that source, the certification mapping and the entire local
mapping. The proposal's `provenanceRef` refers to this complete evidence digest.
Changing any of these requires a new pin and a new candidate revision.

The explicit metric definition is **not inferred from upstream SQL**. Staging
only checks its envelope and tenant binding, not SQL equivalence, catalog
freshness or semantic correctness. Those require the existing owner review,
validation, release-bound compiler and source/policy gates. Upstream SQL remains
inert review context even if it is certified or contains unsafe statements.

## Candidate Admission

Trusted integration code can call `recordNvidiaSemanticProposal(access,
bundleJson, expectedDigest)` with an already authenticated `ControlAccess` and
the separately retained pin. The helper reconstructs and verifies the bundle,
checks the exact local tenant, then uses the existing immutable candidate
insertion. It rechecks active reviewer/owner membership and the named local
owner in that write. Upstream owner IDs and zones never become local roles.

This records only a candidate and its provenance reference. Store the full
bundle in the operator's access-controlled evidence store; D1 does not retain
the raw upstream document. No validation, approval, release, grant, budget,
job or receipt is generated. Reusing a revision ID cannot overwrite an earlier
import. A content digest detects changes against a trusted pin; it does not
authenticate the exporting server or prove the claimed capture time/version.

No database migration, live import, OAuth configuration, production identity
change, benchmark freeze or Gateway scoring is part of this adapter.
