# Cube metadata intake

The [shared offline intake](../semantic-metadata/README.md) accepts the JSON
body of an authorized Cube REST `/v1/meta` export. It selects exactly one
cube/view by `containerId` and exactly one measure by `resourceId`. Duplicate
containers or matching measure names, including cross-container collisions,
are rejected. A dimension cannot substitute for a measure.

Use `sourceFormat: cube.rest-meta.v1`. Measure `type` must be a supported scalar
metadata type; optional `aggType` stays inert context. The operator supplies
the source version separately because the response does not establish it.
This version is pinned as an unverified assertion, not treated as compatibility
proof. All raw metadata is retained in the private review bundle.

The output is an ODAP candidate with an explicit local definition, not a Cube
query. There is no `/load`, `/sql`, SQL API, pre-aggregation, model-export,
token handling or query cancellation in this adapter. It does not reproduce
Cube access policies or bypass them by directly running extracted SQL.

Reference: [Cube REST API metadata](https://docs.cube.dev/reference/core-data-apis/rest-api/reference#base_path-v1-meta).
The fixture is synthetic and validates the documented selected-resource shape;
no Cube server was contacted and no upstream endorsement is claimed.
