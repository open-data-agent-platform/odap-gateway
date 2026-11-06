# Settled BigQuery evidence (local engineering)

This internal export answers one question: do the records for a particular
settled intent agree? It is not an ODAP standard, a signed attestation, a
warehouse lookup or a grant to execute the job again.

## Export

`exportSettledEvidence(access, intentId)` runs one parameterized SELECT. It
requires an active owner of the requested tenant in the same database snapshot.
Missing, incomplete, legacy unattributed and inaccessible chains return
`null`; an inconsistent returned chain raises an error, not a partial export.
Read from a local database with migrations through 0026 applied. The reader
does not run migrations, require a new role, expose a route or call a provider.

The database reader requires a matching [creation event](EVIDENCE_COVERAGE.md#interpreting-the-counts)
for **both** the pending and final receipt. Missing, duplicate or mismatched
events withhold the export; the reader does not append a replacement event.
Migration 0028 indexes this lookup without changing any historical row.
Event rows are not part of the portable profile: a detached verifier cannot
determine from the JSON alone whether those rows exist in the source database.

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

### Correcting an explanation

With migration 0030, an active tenant owner can append a corrected explanation
to an issued receipt. The local Gateway exposes this separately from the
issued receipt at `/api/control/{tenant}/receipt-corrections/{receiptId}`.
The HTTP handler derives `ControlAccess` from a signed session. The original receipt and any
exported bundle still contain the original reason; inspect corrections
separately. A note cannot change the outcome, adjust a charge, authorize a
refund or dispatch a job.

```ts
const latest = await readReceiptReasonCorrection(access, receiptId);
const saved = await appendReceiptReasonCorrection(access, receiptId, {
  expectedRevision: latest?.revision ?? 0,
  correctedReason: "The charge covers this job only.",
  evidenceRef: "ticket:42",
});
```

The caller supplies a short explanation and an opaque evidence reference,
not credentials, raw customer data or a new receipt payload. The service
records the owner and database time. Revision 1 corrects the issued reason;
each subsequent revision supersedes the preceding explanation. Pass a revision
to the read function to inspect it. After a conflict, reread and consider the
new version before resubmitting. Retrying the identical command as the same
owner returns its original version. Loss of access is not an empty history.

Use GET for the latest correction or add `?revision=1` to inspect a specific
version. A successful response contains `{ ok: true, correction }`. Only
the latest view returns a null correction for an eligible, unannotated
receipt. A missing version or unavailable receipt returns 404, not an empty
history. Responses are not cached.

POST to the same path with no query string, a same-origin session request
and an `application/json` body containing only `expectedRevision`,
`correctedReason` and `evidenceRef`. Use 0 for the first revision.
A conflicting command returns 409; reread before deciding whether to submit
again. Unauthenticated callers receive 401; a session without the required
membership or role receives 403. Storage faults return 503 without driver
diagnostics. Never infer from a 503 that no write occurred.

On the local Evidence receipt page, look up the receipt, then select **View
reasons**. The ordinary summary does not request reason text. This separate
owner-only GET (`/api/control/{tenant}/receipt-explanations/{receiptId}`)
returns the issued reason and latest recorded correction in one database
snapshot. It does not return audit identities, evidence references or the
full receipt. A null latest correction means no annotation was recorded;
missing audit evidence or a failed read does not. Switching lookups or
hiding the page clears the displayed details.

To append a note, select **Add correction** after viewing the reasons. Enter
the corrected reason and an opaque evidence reference, then select **Submit
correction**. The form submits the version on screen (zero when there is no
correction); it does not fetch a newer version and silently reuse the draft.
Cancel sends nothing. The confirmation names the acknowledged revision,
not necessarily the latest revision. After a conflict or unconfirmed
response, **Read latest reasons** performs a GET, never a retry. If another
revision has since superseded the attempted one, use **Inspect revision**.
After a lost response the revision number is prefilled, but nothing is read
until requested. Compare the recorded actor, reason, evidence reference and
time; equal reason text alone does not identify your write. An unavailable
revision is not proof that the request failed. Historical inspection is
read-only. To submit a new correction, first use **Read latest reasons**.

Each appended revision and its audit event commit in one statement. Missing
or mismatched audit evidence for the source receipt or a stored revision blocks
the correction service. This is not independent custody or detection of a
wholly removed history. A detached verifier sees no corrections in the
existing portable profile.

### Delegated settlements

Nondelegated exports keep their original profile and bytes. A delegated
settlement uses the separate local profile
`odap.gateway.local.settled-delegated-bigquery.v1`. Its `delegation` section
copies the audience from admission, claim, observation and bill; the compiled
request digest from claim, observation and bill; and the project and location
from the bill. The final receipt links it to the exported job ID. No compiled
SQL or credentials are exported. The three control-object wire schemas do not
change.

Supply the expected audience to `exportSettledEvidence(access, intentId, audience)`
or to `verifySettledEvidence(json, {tenantId, intentId, audience}, digest)` when
delegated evidence for that audience is required. A legacy export cannot meet
this constraint. Without an audience, a current tenant owner can inspect
either kind of settlement; revoked execution authority is not needed to read
historical evidence. Older delegated bills without pins and mixed-source
chains yield no export. These comparisons do not authenticate the original
issuer or establish that a provider actually invoiced the reported amount.

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
lowercase hex digits, optionally followed by one line ending. Append
`--audience <expected-audience>` to require delegated evidence for a known
audience. Supply that value from outside the bundle; a legacy bundle or a
different audience then fails the scope check even with the correct pin. For real
checks, obtain that pin independently; the adjacent repository fixtures are
test vectors, not an independent trust source. The CLI accepts regular files
only (bundle up to 4 MiB), rejects invalid UTF-8 and does not trim or repair
the JSON. A successful check writes one JSON report to stdout (exit 0);
rejection writes a diagnostic to stderr (exit 1); invalid usage exits 2.

The SQLite test regenerates the canonical sample with fixed synthetic
timestamps and compares it to the committed file. Updating that snapshot
does **not** update the pin. Review changes before deliberately replacing a
test pin. Never use a tenant export as a fixture.

## Cancellation with a nonzero bill

The end-to-end case in `tests/bigquery-terminal-observations.test.ts` starts
with one pending receipt, a bounded claim and 20 micro-USD reserved. The
owner's request does not establish a cancellation. A simulated, matched job
lookup reports `cancelled` and 47 billed bytes; no settled export is available
and all 20 units remain reserved. Only the synthetic final bill sets the cost:
two concurrent reconciliations for 7 micro-USD produce one settlement, 7 spent
and 0 reserved. A later cancellation retry returns the original request.

The detached CLI reads the resulting bundle and a separately retained test
digest and reports `cancelled` and 7 micro-USD. It verifies the settled
evidence, not the request's provenance or whether the request caused the
cancellation. No cancellation was sent to a warehouse.

## Recover from a synthetic snapshot

`tests/settled-evidence.test.ts` takes two SQLite `VACUUM INTO` snapshots
of the same fixture: one after terminal observation but before billing, and
one after settlement and export. It restores each to a separate new file,
checks SQLite integrity and foreign keys, and exports through a read-only
connection to that file. The expected digest comes from the settled export
**before** backup, not from the restored database.

The earlier copy contains one pending receipt, keeps the reservation and
cannot yield a settled export. The later copy exports identical canonical
bytes and passes verification against the retained digest. This is a local
point-in-time restore test, not a production backup procedure, a retention
policy or issuer authentication.

### Delegated restore drill

The [delegated drill](../tests/delegated-snapshot-restore.test.ts) restores a
cancelled, revoked delegation at two points. The operator's simulated job
observation is the same in both; only the second copy has a final bill.

| Restored state | Held in shared budget (micro-USD) | Spent | Receipts for this job | Coverage |
| --- | ---: | ---: | ---: | --- |
| Pending bill | 100 (80 for this job, 20 for another) | 0 | 1 pending | Pending billing; no final export |
| Settled | 20 for the other job | 12 | 1 pending, 1 final | One attributed settlement |

Before each snapshot, the drill saves the owner-scoped recovery state and
coverage outside the SQLite file. For the settled snapshot it also saves
the canonical bytes and a separately computed SHA-256 pin. Each recovery
opens a fresh copy read-only, checks SQLite integrity and foreign keys,
compares the retained state and verifies that the database bytes did not
change. The detached CLI checks the settled export against the retained
pin and expected audience, and rejects the wrong audience. No warehouse or
billing source is consulted during restore. This does not test production
backup storage, retention duration or an independent custodian.

### Restore evidence without restoring access

A matching evidence digest says nothing about membership changes after
the backup. In the [isolated receipt-read drill](../tests/restore-membership-boundary.test.ts),
the same signed fixture session received 403 from the post-revocation
database and 200 from the older snapshot despite identical receipt bytes.
Read-only SQLite prevents writes, not disclosure. Do not bind a restored
database to a serving Worker or use its old memberships as current authority.

For isolated recovery, obtain a separate, current, trusted reference with
the complete `control_memberships` table for the same Gateway. The
[offline comparison](../scripts/check-restore-memberships.py) requires two
quiescent standalone SQLite copies, with rollback-mode headers and no
journal sidecars (Python 3 with SQLite 3.37 or later). Do not remove journal
files to make a live database pass. Run from the Gateway directory:

```sh
python scripts/check-restore-memberships.py --restored restored.sqlite --reference current-memberships.sqlite
```

| Exit | Interpretation |
|---|---|
| 0 | The active sets and role values match. No authorization to serve. |
| 1 | Active grants appear only on the restored side, only on the reference side, or in both with a different role. Keep isolated. |
| 2 | No usable comparison, including missing files, same-file inputs, or invalid rows. Keep isolated. |

The tool compares exact tenant/principal pairs, reads neither receipt
payloads nor session secrets, and emits counts without identifiers. It
does not authenticate the reference, detect two stale copies of the same
history, check post-backup delegations or dispatch claims, or reconcile
permissions. A reference with unknown freshness or provenance is unusable.
Reopening any API is a separate decision with other recovery checks.

### A missing dispatch claim is not permission to retry

Job preparation creates the job address and a pending receipt **before**
the one-time dispatch claim. The local sender is called only after claim
insertion is confirmed. Losing that database acknowledgement can leave a
claim without a send; losing the sender acknowledgement leaves the warehouse
outcome unknown. A backup taken before either event cannot distinguish them
from a job that stayed parked. Do not start a sender against a restored copy.

With a separately retained, trustworthy later ledger from the same Gateway,
compare the *recorded claims* across all tenants (schema through 0024 or
later). Use the same standalone-copy requirements as the membership check.

```sh
python -B scripts/check-restore-dispatch.py --restored restored.sqlite --reference later-ledger.sqlite
```

Exit 1 reports counts of claims found only in the reference, only in the
restore, or with different recorded values for the same tenant and intent.
Comparison includes the recorded actor/time, byte cap, delegation audience
and body digest, job address, action tag, pending receipt ID, action digest
and contract ID. It does not emit those values. Exit 0 means only that
these rows match, including two empty ledgers. Exit 2 gives no comparison.
No exit code establishes reference freshness, verifies a warehouse submission
or authorizes replay, cancellation, a budget refund or API traffic.

The [offline drill](../tests/delegated-snapshot-restore.test.ts) keeps the
same pre-claim bytes for two histories. The parked reference matches; the
post-attempt reference adds one claim for the same job and pending receipt.
Drift in just the compiled-body digest is detected despite equal claim counts.
Keep the restored copy isolated; reconcile against independent job evidence
through an authorized observation process, never by resubmitting the job.

### Conflicting outcomes block settlement

Two observations for the same tenant and intent can legitimately agree on
the outcome while the later one adds billed bytes. If their outcomes differ,
neither observation takes precedence. Both billing adapters refuse to look
up a charge for a known conflict and recheck the stored evidence before
writing or returning a billing state. A missing charge does not turn a
conflict into "pending". Migration 0027 also rejects direct bill inserts
for that intent; it does not reverse a prior debit or repair historical data.
Keep the copy isolated and reconcile the competing observations against an
independent source before trusting a receipt. Do not retry dispatch or
release the reservation to clear the error.

Delegated recovery also refuses to report an outcome or start an observer
lookup when the stored samples already disagree. If a conflict appears
during lookup, neither a missing job nor a terminal response resolves it.
Cancellation status and cancellation retries likewise return an error, not
an inferred warehouse outcome. Any previously recorded cancellation request
remains a request; its presence is not proof that cancellation succeeded.
