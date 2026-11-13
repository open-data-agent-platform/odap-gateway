# Recorded cancellation request evidence

This Gateway export preserves the recorded provenance of a delegated
cancellation request. It does not establish that a request was sent, received,
or caused a warehouse cancellation. It neither verifies a charge nor releases a
budget reservation. It is a local engineering profile, not an ODAP wire standard.

## Read an authorized snapshot

`exportCancellationEvidence(access, audience, intentId)` performs one parameterized
SELECT against a local database with migrations through 0034. The caller must
derive `ControlAccess` from its trusted authentication boundary; this function
is not itself an authentication endpoint. The statement checks active ownership
of the requested tenant and binds the expected audience and intent. It does not
apply migrations, retrieve credentials or call BigQuery.

Missing, inaccessible, legacy unattributed and mismatched requests return `null`.
That is not proof that no cancellation occurred. Read failures throw rather than
becoming an empty export. The source requires a matching pending receipt creation
event and the existing delegated claim/admission/job links. It does not rewrite
old rows to add attribution. Exporting after owner replacement preserves the
original requester; the reader must be a current owner, not the original actor.
Grant withdrawal does not erase history or permit execution again.

The result contains canonical JSON and its SHA-256 digest. The independent local
profile `odap.gateway.local.delegated-cancellation-request.v1` includes tenant,
intent, audience, contract and action references; the bounded job address and
pending receipt ID; the claim actor/time, body digest and byte cap; and the
request actor/time and matching job/audience/digest. It contains no query text,
parameters, result rows, tokens, provider diagnostics, terminal outcome or bill.
Identifiers and project metadata are still private and require appropriate handling.

## Authenticated HTTP read

`GET /api/control/{tenant}/cancellation-evidence/{intent}` uses the signed session
and current active tenant ownership, then rechecks ownership in the export
snapshot. Under a path-mounted deployment, prepend the configured base path.
The server supplies the delegation audience. Query parameters and other HTTP
methods are rejected; identity headers cannot grant access. Responses use
`Cache-Control: no-store`.

A successful response is `{ok:true,evidence:{tenantId,intentId,audience,json,digest,
scope,source,...}}`. The scope is `recorded-request-only` and the source is
`stored-evidence`. `issuerAuthenticated`, `cancellationConfirmed`,
`providerContacted`, `cancellationAuthorized`, `executionAuthorized` and
`settlementAuthorized` are all false. Later terminal observations do not change
the request evidence or turn it into confirmation of cancellation.

Invalid sessions receive 401. Non-owners, missing or inaccessible requests and
incomplete provenance receive the same 403 response. Missing audience configuration
or unavailable storage gives 503, never an empty or successful export. This read
requires schema 0034: older 0032/0033 databases remain unchanged and return a
sanitized storage-unavailable response after authentication and ownership checks.
Deployment does not authorize or apply a database upgrade.

## Local MCP cancellation evidence tool

`odap_cancellation_evidence` accepts exactly `{"tenantId":"...","intentId":"..."}`.
The host supplies a fresh signed request context and database binding on every
call; no cookie, role, audience, endpoint or action parameter is accepted.
It calls the same service as HTTP and returns the identical body as a text result,
with `isError` on denial or failure. The tool is read-only and cannot send a
cancellation, refresh provider status or settle a reservation.

The existing local [stdio transport](EVIDENCE_COVERAGE.md#local-stdio-transport)
requires initialization before calls. This integration creates no public MCP
listener, OAuth configuration or independent client acceptance claim.

## Verify without a database

The **Cancellation request** page is linked from job recovery, evidence receipts
and settled evidence. It reads only the current owner's stored request and checks
the exact profile, scope and checksum before showing requester/time/job references.
It displays **Request recorded**, never a terminal outcome or a charge. The page
does not send cancellations, refresh provider status or upgrade storage.

**Download JSON** preserves the exported canonical bytes; **Download checksum**
contains the SHA-256 pin plus one newline. File names use only the checksum.
Editing the tenant/intent, rereading, hiding or leaving the page clears the old
result; late responses cannot restore it. No evidence or identity is persisted in
browser storage. Authentication, authorization and unavailable/legacy-storage
responses withhold the bundle rather than presenting empty or successful evidence.
Browser-side consistency checking is not issuer authentication or independent custody.

`verifyCancellationEvidence(json, { tenantId, intentId, audience }, expectedDigest)`
checks the exact profile/fields, canonical representation, scope, deterministic
job identity, attribution pins and nondecreasing claim/request times. Its input
limit is 64 KiB in UTF-8. A new request owner may differ from the claim owner.
Expected scope must come from outside the file. The existing settled-evidence
profiles and bytes are unchanged; inspect outcomes and billing separately.

Build with the existing `npm run evidence:build`, then run the generated tool
outside the checkout with Node and independently supplied scope and pin:

```sh
node dist/evidence/scripts/verify-cancellation-evidence.js request.json tenant intent audience expected.sha256
```

The pin file is mandatory for this CLI and contains `sha256:` plus 64 lowercase
hex digits, optionally followed by one line ending. Regular-file and strict UTF-8
checks reject BOM, malformed and oversized input. Exit 0 prints a report with
`consistent: true`, `issuerAuthenticated: false`, `cancellationConfirmed: false`
and scope `recorded-request-only`. Exit 1 rejects input; exit 2 indicates invalid
usage. Diagnostics do not echo private file names or evidence excerpts.

A matching digest is not issuer authentication. An attacker who can replace the
whole history can create another consistent bundle and checksum. Independent pin
custody can detect later replacement, but cannot prove the original actor's
authority, a truthful source database or the warehouse's behavior. The portable
profile also cannot verify that source audit rows still exist. No result grants
permission to send a cancellation, replay a query, serve a restored database,
refund a charge or claim independent acceptance.

The [offline cancellation restore comparison](CANCELLATION_RESTORE.md) checks
two retained database snapshots for lost or changed request provenance, including
legacy unattributed requests. Matching backups do not authorize any retry.
