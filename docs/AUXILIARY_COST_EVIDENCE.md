# Auxiliary Component Cost Evidence

This local Gateway profile exports the recorded model/tool components associated
with one execution intent. It is not a protocol change, a provider signature,
execution permission or proof of total workflow cost. SQL job evidence retains
its existing separate [settled BigQuery profile](SETTLED_EVIDENCE.md).

## Export

`exportAuxiliaryCostEvidence(access, intentId)` uses one tenant/current-owner
scoped SELECT against migration 0033 storage. It includes the intent's attribution
references, every recorded auxiliary hold, any final component bill, and the
corresponding reservation/settlement audit events. It does not call providers,
write records, refresh bills, or filter out pending components. Unauthorized or
missing intents return null; storage errors remain errors, not empty inventories.
Unmigrated databases fail closed without being initialized or repaired.

The export contains canonical JSON plus its SHA-256 digest. Component IDs are
sorted in binary order. More than 1,024 components causes rejection, never a
partial export; individual references and the four-MiB input envelope are also
bounded. Missing, duplicate, incorrectly linked or out-of-order audit events
cause rejection. Reservation/bill timestamps are recorded database times, not
independently confirmed provider times.

Exported bundles can contain tenant/principal identifiers and billing locators.
Retain them under the appropriate local access controls, not in public Git.
The storage owner's authenticated read does not travel with a detached file.
No HTTP/MCP route or production wiring is added by this module.

## Detached verification

```bash
npm run evidence:build
npm run evidence:verify-costs -- bundle.json tenant-id intent-id retained.sha256
```

The CLI runs independently of a running Gateway or database. It requires a
separately retained expected digest, a bounded regular UTF-8 input file and
explicit tenant/intent scope. It rejects malformed/corrupted input without
printing input fragments or private file paths. The library verifier can also
compute consistency/digests for an authenticated export, but that is not an
independently obtained pin. Checksums establish only equality to that pin;
neither the CLI nor a newly supplied matching pin proves who produced a file.

The `odap.gateway.local.auxiliary-costs.v1` profile has the fixed scope
`recorded-auxiliary-components-only`. Verification checks field shapes, unique
component/operation/bill references, audit bindings and chronology, safe integer
component amounts, canonical bytes and an expected checksum when supplied.
The report always says `issuerAuthenticated: false` and
`completeWorkflowCost: false`.

The report separates:
- `recordedComponents`, `settledComponents` and `pendingComponents` as counts.
- `settledActualMicroUsd` as the sum of explicit final recorded component bills.
- `pendingReservedMicroUsd` as the sum of unresolved component holds, not an
  assertion of actual incurred cost or a guaranteed final upper bound.

Aggregate amounts are decimal strings summed with integer arithmetic, so a sum
above JavaScript's safe-number range is not rounded. A final zero bill contributes
zero and is settled; a missing bill remains pending. An empty inventory reports
zero recorded components, not proof that no operations happened or no costs were
incurred. `allRecordedComponentsSettled` refers only to that denominator, even
when it is empty.

A detached snapshot can remain consistent after new bills/components are added.
Its verifier cannot prove freshness, detect every omitted/unrecorded operation
without an external inventory, authenticate provider billing or recover missing
data. Retaining a pin separately detects changes to the retained snapshot, not
changes to the live database. The SQL-only coverage API and verifier are unchanged;
do not add these totals to SQL figures without proving disjoint attribution and
completeness for the intended scope.

## Verification boundary

Tests exercise actual SQLite/native-D1 reads and detached CLI use with synthetic
data: current-owner/tenant checks, unknown and late bills, exact sums, immutable
older snapshots, duplicate/missing audit records, bounded export, tampering and
invalid files. The legacy settled-evidence CLI uses the same bounded file reader
and keeps its existing arguments, output and failure behavior. These are author
tests, not independent acceptance, live provider integration or a production
migration authorization.
