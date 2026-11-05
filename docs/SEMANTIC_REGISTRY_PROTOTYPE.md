# Experimental Local Semantic Registry

This development prototype implements a local candidate lifecycle. It is not a
production service, NVIDIA connector, or a new v0.1.0 capability. It does not
change the Five Musts, Rubric, or clause mapping.

Run with Node.js 20+:

```sh
node scripts/semantic-registry.mjs /tmp/odap-demo/registry.json action.json
```

Create `action.json` with this synthetic candidate:

```json
{
  "type": "propose", "actor": "demo-extractor",
  "name": "paid_order_amount", "expression": "SUM(amount)",
  "source": "demo.orders", "sourceRevision": "schema-v1",
  "extractor": "demo-v1", "owner": "demo-finance"
}
```

Use the returned candidate `id` in subsequent actions, each in a JSON file:

```json
{"type":"validate","id":"CANDIDATE_ID","actor":"demo-finance","evidence":"demo-review-1"}
```

Then use `approve` and `release` actions with the same ID and owner. The release
returns `releaseId` and a version. Only the named owner can make lifecycle
transitions. `reject` requires a reason; `deprecate` retires a released version.
Changes create new candidates rather than overwriting approved definitions.

```json
{"type":"bind","releaseId":"RELEASE_ID","actor":"demo-analyst","sourceRevision":"schema-v1","allowedSources":["demo.orders"],"sql":"SELECT SUM(amount) FROM demo.orders"}
```

Binding checks release state, definition integrity, source revision, and the
supplied source allowlist. It records the release, definition hash, query hash,
and actor in the local audit history. Deprecated releases cannot bind new queries.

## Trust boundary and limits

The local operator supplies identities, permissions, schema revisions, and
validation evidence. They are not authenticated or fetched from a policy engine.
Validation records evidence; it does not run SQL validation or certify meaning.
Binding records an association; it does not prove SQL uses the metric correctly,
parse SQL, generate SQL, execute a query, or enforce warehouse permissions.

The JSON registry uses an exclusive lock and replacement write. It is local
development storage, not tamper-resistant audit storage or a multi-tenant database.
After an interrupted process, inspect state before manually removing a stale lock.
Keep registry files outside the repository and use only synthetic/public data.

Production API/auth integration, D1 persistence, automated schema validation,
query-generation integration, and budget admission remain future work. No new
conformance status is claimed by this prototype.
