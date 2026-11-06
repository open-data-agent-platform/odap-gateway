# SQL preview policy profile

The legacy SQL editor applies catalog checks to a restricted BigQuery SELECT
profile. It uses the BigQuery-only build of `node-sql-parser`, pinned to 5.4.0
with lockfile integrity. Table and field references come from its syntax tree,
not regular-expression deletion of quotes, aliases or EXTRACT expressions.
See the [parser documentation](https://taozhi8833998.github.io/node-sql-parser/)
for the underlying parser; the Gateway profile below is narrower than its grammar.

## Supported scope

- One SELECT statement over one explicit `dataset.table` or
  `project.dataset.table`, optionally with a table alias.
- Bare or backtick-quoted simple columns, direct projections, plain `*` and
  qualified `alias.*`; a star checks all catalog fields. COUNT(*) does not
  count as exporting every field.
- Explicitly handled arithmetic/comparison/boolean expressions, literal lists,
  CASE, supported scalar functions, COUNT/COUNTIF/SUM/AVG/MIN/MAX, simple casts,
  EXTRACT and intervals. Function names are allowlisted in
  `lib/preview-sql-policy.ts`; custom/qualified functions are refused.
- WHERE, GROUP BY, HAVING, ORDER BY and a nonnegative integer LIMIT. Projection
  aliases may be referenced by the latter grouping/ordering clauses; they never
  remove source references from SELECT, WHERE or aggregate arguments.

The workspace must contain the exact table. Referenced columns must exist and
be queryable. Selected expressions must not reference a PII-marked field, even
inside EXTRACT, a cast, a conditional or an aggregate. A queryable PII field
used only as a filter retains the existing policy: filtering alone is not a
selected-field disclosure check. This does not constitute an inference-control
or anonymization guarantee.

## Refusal and limitations

Invalid SQL, unknown AST shapes and unsupported syntax block the preview with
`schema_policy_blocked` before the BigQuery transport is called. This includes
multiple statements, CTEs, subqueries, unions, joins/comma sources, table functions,
wildcard/decorated tables, time travel, nested/array/whole-row references, window
functions, and star EXCEPT/REPLACE. No partial analysis or regex fallback is used.
Valid BigQuery syntax outside this profile can therefore be refused deliberately.

Input is capped at 20,000 characters; the AST visitor also bounds nesting and
visited nodes. These are resource limits, not a measured CPU latency guarantee.
Parser errors are replaced by a static unsupported-profile reason. SQL is not
rewritten, and no schema migration or new permission is introduced.

This remains a preview/catalog check, not an authenticated tenant binding,
execution grant, Approval Contract or production SQL authorization service.
Production raw previews remain refused by `production_preview_scope_unbound`.
The release-bound structured metric compiler is unchanged. A configured demo
preview still requires its existing signed-in session; simulation never contacts
the warehouse. Historical preview records are not reclassified or backfilled.

Tests cover rejected reference-hiding examples, safe positive controls, bounded
traversal, unknown AST refusal and the mounted API in the installed Workers
runtime. All inputs/identities are synthetic. They do not establish real pilot
acceptance, general SQL equivalence or independent conformance.
