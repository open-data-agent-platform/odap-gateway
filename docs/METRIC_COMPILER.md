# Release-bound BigQuery metric compiler

The internal dispatcher accepts a metric action, not an SQL string. For a
concrete example see the [synthetic revenue definition](../tests/fixtures/revenue-metric.json):
the approved measure sums `net_amount` on the orders table and requires an
integer order year. Changing that to gross revenue changes the definition digest
and requires a different Semantic Release.

The trusted loader takes `{tenantId, releaseId}` and returns a JSON document.
Its entire parsed value is encoded with `canonicalControlJson`, then hashed
as UTF-8 SHA-256 with the `sha256:` prefix. Its profile must be
`odap.bigquery-metric.v1`; its tenant and source revision must match the
released snapshot, and its target and metric must match the bound action.
A matching digest does not establish authorization by itself. The original
CLI prototype's free-form expressions and hashes are not compatible and
are never automatically certified.

The supported query is deliberately narrow:

- One fully qualified table in the adapter project. Dataset, table and column
  identifiers must be simple ASCII identifiers. No joins, wildcards, table
  decorators, raw SQL, user functions or optional execution options.
- One scalar measure: `COUNT_ROWS` or `SUM` of one declared column.
- Up to 16 required equality filters. The name set must match exactly;
  `STRING`, `BOOL` and safe-integer `INT64` are supported, not null or coercion.
  A zero-filter read is allowed only if the definition names no filters.
- Query text is built from validated identifiers and fixed templates. Filter
  values travel separately as [BigQuery named parameters](https://cloud.google.com/bigquery/docs/parameterized-queries).

A missing, changed or unsupported definition fails before the dispatch claim;
policy and membership are still rechecked after loading and compilation.
The output is a **query configuration fragment**, not a complete executable
job. The dispatcher subsequently adds the
[scan byte ceiling](BIGQUERY_SCAN_LIMITS.md) before handing it to the adapter.
No public submission route, live schema verification or production definition
loader is provided here. Warehouse access controls, safe views, schema drift
detection and enforcement by the warehouse remain necessary.
