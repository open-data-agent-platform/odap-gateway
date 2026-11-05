# Settled BigQuery evidence (local engineering)

This internal export answers one question: do the records for a particular
settled intent agree? It is not an ODAP standard, a signed attestation, a
warehouse lookup or a grant to execute the job again.

## Export

`exportSettledEvidence(access, intentId)` runs one parameterized SELECT. It
requires an active owner of the requested tenant in the same database snapshot.
Missing, incomplete, legacy unattributed and inaccessible chains return
`null`; an inconsistent returned chain raises an error, not a partial export.
No migration, new role, public route or network access is needed.

The result contains `json` (canonical UTF-8 JSON text with no BOM or trailing
newline) and `digest` (SHA-256 of that exact text). It includes the release,
approval, admitted intent, bounded dispatch identity, pending and final
receipts, terminal observation, billing reference and matching settlement.
The observation is the **first** terminal sample: if its bytes were unknown,
they remain null in this snapshot. Later usage enrichment does not change the
export or turn a byte count into money. Costs are integer micro-USD.

The projection does not fetch query text, parameters, rows, tokens or raw
invoices. It **does** include tenant and actor identifiers, project, business
metadata and control-object text. Treat even a verified export as private.

## Verify offline

```ts
import { verifySettledEvidence } from "../lib/settled-evidence";

const report = await verifySettledEvidence(
  json, { tenantId, intentId }, independentlyRetainedDigest
);
// report: consistent, issuerAuthenticated, digest, receiptId, outcome, actualMicroUsd
```

Supply the expected tenant and intent from outside the document. The verifier
checks the original object shapes and reference chain, recomputes the job ID
and action tag, and checks outcome, receipt IDs, monetary units and settlement
actor. It does not consult a database or require credentials. The optional
digest must match if provided; reformatting the file is not supported.

**A match is not issuer authentication.** Someone can rewrite an entire
consistent bundle and recompute its digest. Retaining the digest independently
can detect that later replacement, but cannot establish that the original
warehouse observation or invoice was truthful. This checker neither evaluates
current permissions nor proves the metric definition from its digest alone.

The local integration suite is `tests/settled-evidence.test.ts`. It uses a
temporary migrated SQLite database, simulated dispatch and billing, and opens
the export connection in read-only mode. No real data is needed.

## Verify a file

From the Gateway checkout with its development dependencies already available,
build once locally. The generated verifier in `dist/evidence/` then needs only
Node.js (20.11 or later), the bundle, its expected scope and a separate pin
file. It does not open SQLite or contact a provider.

```sh
npm run evidence:build
node dist/evidence/scripts/verify-settled-evidence.js tests/fixtures/settled-job.json t i tests/pins/settled-job.sha256
```

The synthetic example reports `consistent: true`, `issuerAuthenticated: false`,
`outcome: "cancelled"` and `actualMicroUsd: 0`. Its tenant is `t` and its
intent is `i`. Using an unrelated expected tenant must fail:

```sh
node dist/evidence/scripts/verify-settled-evidence.js tests/fixtures/settled-job.json other i tests/pins/settled-job.sha256
# stderr: Evidence scope mismatch; exit 1
```

The fourth argument is mandatory: a local file containing `sha256:` plus 64
lowercase hex digits, optionally followed by one line ending. For real
checks, obtain that pin independently; the adjacent repository fixtures are
test vectors, not an independent trust source. The CLI accepts regular files
only (bundle up to 4 MiB), rejects invalid UTF-8 and does not trim or repair
the JSON. A successful check writes one JSON report to stdout (exit 0);
rejection writes a diagnostic to stderr (exit 1); invalid usage exits 2.

The SQLite test regenerates the canonical sample with fixed synthetic
timestamps and compares it to the committed file. Updating that snapshot
does **not** update the pin. Review changes before deliberately replacing a
test pin. Never use a tenant export as a fixture.
