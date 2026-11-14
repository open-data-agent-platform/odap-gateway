# dbt manifest intake

The [shared offline intake](../semantic-metadata/README.md) accepts a
`manifest.json` with the exact
[v12 schema identifier](https://schemas.getdbt.com/dbt/manifest/v12.json).
Use `sourceFormat: dbt.manifest.v12`; `containerId` is the package name and
`resourceId` is the full metric `unique_id`.

The selected entry must be under `metrics`, have `resource_type: metric`,
agree with its dictionary key, package and name, and be unambiguously enabled.
Duplicate unique IDs, an explicit disabled configuration, conflicting disabled
entries, schema/version mismatches or unsupported metric types are rejected.
The mapping's asserted version must equal `metadata.dbt_version`.

The adapter accepts the selected-resource envelope for simple, ratio, derived,
cumulative and conversion metric types. It does not translate or evaluate
`type_params`; all types still require an explicit local definition and owner
review. It is not a full v12 JSON Schema validator, dbt parser or MetricFlow
compiler. Model/source node ingestion and `semantic_manifest.json` are not
implemented by this module.

No dbt command, profile, warehouse adapter, Cloud API, credential or job is
invoked. Exact source text and operator assertions are pinned as private review
context, not authenticated provenance or production approval. Tests use a
synthetic manifest, not an export from an actual dbt invocation.

Reference: [dbt manifest documentation](https://docs.getdbt.com/reference/artifacts/manifest-json).
This integration is maintained by ODAP; it is not an upstream contribution or
endorsement.
