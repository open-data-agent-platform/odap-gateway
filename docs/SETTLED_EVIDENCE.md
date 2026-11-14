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
does not run migrations, require a new role or call a provider.

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

### Authenticated export read

GET `/api/control/{tenant}/settled-evidence/{intentId}` (under `/gateway`
on a mounted deployment) exposes the existing delegated settled export.
It derives the principal from the signed session, requires current tenant-owner
membership, and takes the expected audience only from the server's
`ODAP_DELEGATION_AUDIENCE`. Ownership and evidence links are checked again in
the export statement. Query parameters and non-GET methods are rejected.
No warehouse lookup, billing retrieval, settlement, retry or migration occurs.

The uncached JSON response is `{ ok: true, evidence }`. The evidence envelope
contains tenant/intent/audience, the exact canonical `json` string, its `digest`,
`source: "stored-evidence"`, and false flags for `issuerAuthenticated`,
`providerContacted`, `executionAuthorized` and `settlementAuthorized`.
Decode the envelope once: verify the bytes of its `json` field, not the outer
response or a pretty-printed copy. Both the export and detached verifier enforce
the same 4 MiB UTF-8 evidence limit.

Unauthenticated callers receive 401. Missing ownership, an inaccessible intent,
an incomplete chain, conflicting outcomes or a legacy/unattributed settlement
receive the same 403 response without a partial bundle. Invalid paths or query
parameters receive 400; unconfigured audience, unsupported storage or an invalid
returned chain receive sanitized 503 responses. A refusal is not evidence that
no job ran, no charge remains, or a retry is safe.

Historical withdrawal of an execution delegation does not erase the export;
current owner access is still required. The digest delivered alongside the
bundle checks consistency, not independent custody or issuer authenticity.
Retain a digest independently for later tamper comparison. No public MCP
transport, production billing integration or independent acceptance
is implied by this read endpoint.

### Owner download page

Open **Settled evidence** from Evidence receipt or Job recovery, enter the
tenant and intent, and explicitly read the stored export. The page checks the
envelope, expected scope, delegated reference chain, canonical bytes and digest
before showing an outcome or enabling downloads. It applies the same 4 MiB
evidence bound, a separate escaped-envelope bound and a bounded body-read time.
Errors withhold the bundle; they do not establish a safe retry or absent charge.

**Download JSON** saves the exact canonical UTF-8 bytes. **Download checksum**
saves the accompanying `sha256:` digest plus one newline. Filenames use the
digest rather than tenant identifiers. These two files share a source: saving
them together is not independent custody or issuer authentication. The page
shows that limitation even after consistency checks pass.

Changing scope, starting another read, hiding evidence or hiding the page clears
the displayed bundle and cancels an outstanding read. Nothing is written to
browser storage, and no download starts until requested. A saved file remains
the user's private copy; hiding the page cannot retract it. Every reread uses
the authenticated owner endpoint, with no provider contact or accounting write.

### Local MCP settled evidence tool

The existing local MCP profile also exposes `odap_settled_evidence` with only
`tenantId` and `intentId`. It calls the same `requestSettledEvidence` service
as the HTTP route. The host supplies a fresh authenticated request and configured
audience independently of tool arguments; metadata cannot assign identity,
membership or audience. Extra parameters, including refresh, settlement and
caller-provided digest, are rejected. The read-only annotations are descriptive;
the shared service and owner-scoped snapshot enforce access.

The result's text contains the same JSON envelope as HTTP. Parse that text once,
then use `evidence.json` and `evidence.digest` without reformatting the bundle.
The 4 MiB UTF-8 limit applies to the canonical evidence, not the escaped outer
RPC envelope. Missing or refused chains return `isError: true` with the same
sanitized code and no partial bundle. That result does not establish that no
job ran or that retrying is safe.

`serveCoverageStdio` requires initialization and checks the host session and
current ownership on every call, including repeated calls on one pipe. This
addition creates no public MCP endpoint, default process, credentials or
database. Synthetic SQLite/native D1 and pipe checks are engineering evidence,
not independent client adoption, issuer authentication or production custody.

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

Both local settled profiles also require nondecreasing recorded times: pending
receipt, dispatch claim, terminal observation, then final receipt/billing. Equal
timestamps are allowed because the records have millisecond precision. The claim
must precede the contract's expiry strictly; observation and billing may follow
expiry. Verification does not compare with today's clock or require a historical
contract to remain active. Reversed times, including clock-regression artifacts,
are inconsistent evidence, not repaired or reordered records. A matching checksum
does not excuse an inconsistent chain. This checks the declared database times;
it neither authenticates a clock nor proves when the warehouse executed a job.

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

Recorded delegated request provenance has a separate
[owner-scoped export and detached verifier](CANCELLATION_EVIDENCE.md).
It does not change either settled profile or add a cancellation-success claim.

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

### Delegation history is separate from membership

An older snapshot can retain the same members while losing a delegation
revocation, public verification key disablement or already-used proof record.
The [offline regression](../tests/restore-delegation-authority.test.ts) reproduces
acceptance of the same synthetic proof on the older isolated copy and refusal
on the later copy for each of these three changes. It does not issue a contract,
prepare or dispatch a job, or contact an external provider.

For separately obtained trusted snapshots from the same Gateway, schema 0020 or
later, use the same standalone-copy requirements:

```sh
python -B scripts/check-restore-delegations.py --restored restored.sqlite --reference later-ledger.sqlite --tenant tenant-id
```

The tool compares all recorded tenant verification public keys, requests, human
grants, delegations and proof markers, including disabled, revoked and expired
history. It checks exact reference bindings, public-point encoding, action digests,
grant/proof/revocation chronology and uniqueness; each table is bounded to 10,000
rows. It never reads private signing keys, session secrets or result payloads.
Counts alone are emitted, not identifiers, public points, digests or timestamps.
Exit 0 means equal stored sets (possibly equally stale); exit 1 reports per-table
missing/extra/changed counts; exit 2 means no usable comparison. None authorizes
serving, execution or proof replay. A proof marker is not a signature verification,
and public-point encoding is not curve validation or issuer authentication.
This does not check the entire semantic/policy graph, current expiry/eligibility,
dispatch claims or independently establish reference freshness. Keep copies isolated;
do not erase proof/revocation history or reenable keys to repair a discrepancy.

### Retain release retirement history

An older snapshot can lose a release retirement while membership, delegation,
stop and claim comparisons still match. The [isolated regression](../tests/restore-retirement-provenance.test.ts)
shows that the later copy's actual database guard refuses a new claim while the
older copy accepts that same claim. It does not submit a job or call a provider.

For separately trusted snapshots from the same Gateway, schema 0017 or later:

```sh
python -B scripts/check-restore-retirements.py --restored restored.sqlite --reference later-ledger.sqlite --tenant tenant-id
```

The same standalone-copy requirements apply. This read-only tool compares each
recorded tenant retirement's reason, original actor/time and exact linked release
content and creation metadata. It checks v0.1 release bindings, digest encoding,
attribution and chronology; JSON formatting does not change the comparison.
Multiline reasons are preserved. Legacy records without both actor and time remain
explicitly unattributed, including after a prior claim; current membership changes
do not hide them. It neither assigns missing history nor infers cancellation.

Only counts are emitted, never reasons, identities, release content or timestamps.
Exit 0 means equal recorded sets, possibly equally stale; exit 1 reports missing,
extra or changed records; exit 2 refuses malformed, unbound, duplicate, unsupported
or journal-dependent inputs. The inventory is bounded to 10,000 retirement rows.
Comparison does not authenticate provenance, validate every definition or review,
establish freshness, cancel running jobs, release budget, or authorize serving,
execution or replay. Unretired releases and approval-withdrawal history are outside
this check. Do not remove retirement markers to repair a discrepancy.

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

### Retain pre-dispatch stops during recovery

Matching memberships and dispatch claims can still omit an owner's later stop.
With a separately retained, trusted later snapshot from the same Gateway, compare
the recorded stops for an explicit tenant (schema 0011 or later):

```sh
python -B scripts/check-restore-stops.py --restored restored.sqlite --reference later-ledger.sqlite --tenant tenant-id
```

The same standalone-copy requirements apply. Exit 0 means only the recorded sets
match, including two empty or equally stale sets. Exit 1 reports counts of stops
only on either side or changed for the same intent. Exit 2 gives no comparison;
malformed/partial attribution, orphan intent references, duplicate markers,
missing schema and more than 10,000 selected rows fail closed. Output contains
counts, not tenant, actor, intent, reason or action values.

Comparison includes the original reason, actor/time and the stored intent's
contract, principal, action digest, budget, reservation and reserved units.
Unattributed historical markers remain separate, even when a prior claim exists.
Current owner or release withdrawal cannot hide history. This is a stored-reference
comparison, not validation of all linked objects, issuer authentication, proof
of reference freshness, a retention policy or evidence of warehouse cancellation.
No result authorizes serving, dispatch, retry, settlement or a budget refund.
Keep the copy isolated; never recreate missing stops or infer permission from
their absence. The [offline regression](../tests/restore-stop-provenance.test.ts)
demonstrates a lost stop that the membership and claim comparators do not detect.

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
