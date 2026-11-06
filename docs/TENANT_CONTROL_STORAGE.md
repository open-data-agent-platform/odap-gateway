# Tenant Control Storage and Read Authorization

Development foundation; no new public release or conformance claim.

Apply `db/migrations/0001_control_objects.sql` to the Gateway D1 database before
using the control API. Back up existing data and test migrations locally first.
This work has not applied a remote migration or changed production resources.

The migration adds tenants, memberships, three immutable object tables and
insert audit events. Composite foreign keys scope release/contract/receipt
references to a tenant; receipt contract/release references must agree.
Database triggers reject object updates/deletes and record successful inserts.
Lifecycle revocation/consumption requires a future separate state/event service;
do not enable live execution based only on stored immutable snapshots.

Provision tenants and memberships through trusted database administration.
There is intentionally no self-enrollment or public membership write API.
Membership principal IDs use `provider:providerId` from the verified session,
for example `google:demo-subject` in synthetic tests. Do not use caller headers,
email matching, or the global admin role as a membership bypass.

`GET /api/control/{tenant}/{kind}/{id}` supports `release`, `contract`, `receipt`.
Workers and Pages use the same handler. Valid session and active tenant
membership are required. Reads recheck membership within the object SQL query.
Responses are no-store. Missing bindings/migrations fail closed; no seed fallback.

### Receipt visibility

| Lookup | Who can read | Returned data |
|---|---|---|
| `receipt/{id}`, no query | Active reader, reviewer or owner in that tenant | Legacy v0.1 object, including the intent ID, reference values and free-text reason |
| `receipt/{id}?view=summary` | Same tenant roles | Receipt and tenant IDs, outcome, timestamp and reference-presence flags; no reason or reference values |
| `intent-receipt/{intentId}` | Active original requester in the admission's tenant and configured audience | [Linked receipt summary, or no receipt yet](BUDGET_INTENT_ADMISSION.md#locate-the-intents-receipt) |

The summary is a smaller representation, not a role restriction on the full
object. Do not put secrets, raw SQL or result data in free-text reasons.
Only a single `view=summary` parameter selects the summary on the by-ID
route. Unsupported, extra or duplicate parameters return 400 after
authentication and membership checks, before reading the receipt. Clients
must not retry a rejected summary request without parameters.

**Review state (local development):** `GET /api/control/{tenant}/review/{revisionId}`
looks up a candidate revision, not a release ID. Use the existing control-route
identifier format (1-128 ASCII letters, digits, underscores or hyphens). With
the local schema through migration 0017, active tenant reviewers and owners
receive `{ ok: true, review: ... }`. The review summary contains the definition
digest, metric and source revision, decision/release IDs, recorded transition
times and one of `candidate`, `validated`, `approved`, `withdrawn`, `published`
or `retired`. It does not expose definition SQL, evidence references or reasons.
An older retirement marker without a date yields `retired` with `retiredAt: null`.
Readers get the same 404 as for a missing revision; nonmembers get 403 and
unsigned requests get 401. A historical release without a linked revision
does not gain a synthetic review history. Neither this summary nor the
historical release endpoint establishes current permission to execute a query.

**Exact definition (local development):**
`GET /api/control/{tenant}/definition/{revisionId}` uses the same active
reviewer/owner read policy. Its no-store response contains `revision.tenantId`,
`revision.revisionId`, `revision.definitionJson` and `revision.definitionDigest`.
After decoding the response envelope, hash the UTF-8 bytes of the
`definitionJson` string as returned, not the envelope or a pretty-printed
copy. The expected value is `sha256:` followed by lowercase hexadecimal.
This is the immutable canonical definition, not the formatting of the
original submission. The server checks tenant, profile, canonical form and
digest before returning it; an inconsistent record yields 503 without its
contents. This checks internal consistency, not independent authenticity or
business correctness. Reading does not create validation or approval evidence.

**Owner approval basis (local development):**
`GET /api/control/{tenant}/approval-basis/{revisionId}` returns a no-store
`basis` containing the tenant, revision ID, definition digest and the exact
recorded `evidenceRef`. The same read checks active named ownership, the
validator, the digest and absence of an approval. Other members, missing
validation and completed decisions receive the same 404. The ordinary review
summary exposes only a `canReviewApproval` hint, not the reference.
The UI displays the reference as text; it does not fetch or certify it.
The separate approval POST still checks current authority and stored evidence.

Immutable-object role policy: reader/reviewer/owner may read; only owner is eligible to use the
internal append primitive. Append checks owner membership within INSERT SELECT,
so an earlier access object is not a reusable role grant. The primitive validates
object shape and tenant but is not an issuer, approval engine or execution service.
The append primitive is not an HTTP write endpoint.

### Control command body admission

The shared JSON reader used by proposal, review/lifecycle, grant, delegation,
contract, budget, job-preparation and receipt-correction commands enforces each
route's existing byte limit against the actual stream, regardless of declared
`Content-Length`. It decodes UTF-8 strictly and requires a complete JSON body.
A single 15-second deadline starts when body admission begins, after any preceding
authentication/configuration checks; another chunk does not extend it. Exceeding
that deadline returns 408 with `{command}_timeout`. Oversize retains 413 with
`{command}_too_large`; malformed, failed or aborted reads return 400 with
`invalid_{command}`. These no-store replies do not include stream error details.

Failure requests stream cancellation without waiting for it to settle, and
releases the reader, abort listener and timer. An already-aborted request is
rejected, and an abort signal during reading interrupts it. Client-disconnect
notification depends on the [runtime's request-signal support](https://developers.cloudflare.com/workers/runtime-apis/request/#properties); the current pinned
Worker configuration does not opt into `enable_request_signal`, so the fixed
deadline is independent of such notification. This is a body-read bound, not an
end-to-end database or execution deadline. It does not cancel a command that has
already passed admission, promise rollback after a lost response, retry a write,
or replace the existing write-time authority checks. Admin and legacy query
readers are outside this shared helper's scope.

### Candidate proposal (local development)

`POST /api/control/{tenant}/proposals` is a cookie-authenticated command for
active reviewers and owners. Supply the request URL's exact origin in
`Origin`, and an `application/json` body with exactly four fields:
`revisionId` (control-route identifier), `ownerId` (an active owner in that
tenant), `provenanceRef`, and `definition` (the structured
`odap.bigquery-metric.v1` object for that tenant). The actor comes from the
signed session, never the body. No approval, SQL execution, or network lookup
of provenance is performed. A candidate is not a certified metric.

The server caps the actual request body at 48 KiB and retains the existing
32,768-character limit on serialized definitions. On creation it returns 201,
the revision ID and computed digest, with a relative `Location` for the review
summary. A duplicate revision, unavailable owner or write-time loss of role
returns 409 without overwriting a revision. Invalid content returns 400;
oversized or non-JSON requests return 413 or 415. This handler and the review
read were exercised locally only.

### Owner validation (local development)

`POST /api/control/{tenant}/validations` accepts exactly `revisionId`,
`reviewedDigest` and `evidenceRef` in same-origin JSON (8 KiB maximum).
Use the digest of the exact definition inspected. The reference is an opaque,
nonblank string of up to 1,024 characters; the gateway does not fetch it or
certify its contents. The command checks stored bytes against the digest and
records evidence only while the signed principal is the active named owner.

A 201 returns the revision ID, digest and review location. A well-formed but
stale digest, duplicate validation, or ineligible revision/owner combination
returns 409 without replacing any evidence. A corrupt stored definition or
storage outage returns 503 without exposing private details. This action does
not approve or publish the revision, execute SQL, or prove that someone read it.

### Owner approval (local development)

`POST /api/control/{tenant}/approvals` requires a signed session and exact-origin
JSON (8 KiB maximum). Supply only `approvalId`, `revisionId`, `reviewedDigest`,
and `evidenceRef`. Both IDs use the control-route identifier format. Supply
the evidence reference recorded during validation; the server never dereferences it.
The definition must still match its recorded digest. The conditional write
also checks the retained validation and current authority of the named owner.

A 201 returns the approval and revision IDs and a review location. A valid
but conflicting request (including missing validation, changed evidence,
duplicate IDs or loss of write-time authority) gets 409 without overwriting
a decision. Malformed content gets 400; storage failure gets 503. This is
approval of the semantic definition only, not publication or an execution
Approval Contract.

### Owner promotion (local development)

`POST /api/control/{tenant}/promotions` accepts only `revisionId`,
`approvalId` and the new `releaseId`, all control-route identifiers.
It requires the signed owner session, exact origin and an at-most-8-KiB
JSON body. Do not send a release payload, catalog mapping or actor identity.
The handler checks the approved review and stored definition; the atomic
database operation enforces current named ownership, trusted source mapping,
withdrawal and uniqueness at issuance time.

A 201 returns `promotion.releaseId` and the relative `Location` of the
immutable release. A business refusal, including a competing promotion or
catalog drift, returns 409 without a partial release. An unexpected storage
or audit error returns 503, not a successful publication. This operation
does not configure a dispatch target, issue an execution contract or run a
warehouse query. Only the synthetic local flow was exercised.

### Owner withdrawal (local development)

`POST /api/control/{tenant}/withdrawals` accepts exactly `revisionId`,
`approvalId` and a nonblank `reason` (up to 1,024 characters). The signed
session, exact origin, control-route IDs and 8 KiB JSON limit apply. The
database checks the current named owner's authority over the exact revision
at the write, and again before disclosing any previous outcome.

| HTTP status | Meaning |
|---|---|
| 201 | First withdrawal. The response contains `withdrawal.status: "withdrawn"` and the database time. |
| 200 | Already withdrawn. The response contains `already_withdrawn` and the original time; the new reason is not recorded. |
| 409 | Already published. The response contains `ok: false`, `code: "already_promoted"` and the existing release ID. No withdrawal or retirement was performed. |
| 404 | No matching approval visible to this caller. No terminal state or release ID is disclosed. |

Both withdrawal responses link to the review summary. A storage or audit
failure returns 503; it is never reported as a successful withdrawal.

### Owner retirement (local development)

`POST /api/control/{tenant}/retirements` accepts exactly `releaseId` and
`reason`. Use a signed session for the release's active named owner, the
same origin and a JSON body of at most 8 KiB. The reason must be nonblank,
trimmed, at most 1,024 characters and contain no NUL. The database checks
ownership at the write and again before returning any prior retirement.

| HTTP status | Meaning |
|---|---|
| 201 | First retirement. `retirement.status` is `retired`; `retiredAt` is the database timestamp. |
| 200 | Retry. `already_retired` includes the original time. A marker that predates attribution returns `legacy_retired` without inventing a time or changing the reason. |
| 404 | No matching release visible to this owner. An absent release and another owner's release return the same response. |
| 503 | Storage or audit failure; no success is reported. |

Every success returns `effect: "future_dispatch_claims_only"` and a `Location`
of `/api/control/{tenant}/release/{releaseId}` identifying the historical
release. The review UI verifies both before accepting a receipt, then reads
the effective review state. A read that
already won the dispatch claim is not canceled; no reservation is released
or charged. The review summary shows the effective state, while the
historical release and its approval remain unchanged.

The new tables coexist with legacy users, workspace policies and query history.
They do not retrofit tenant isolation into every existing endpoint. Global admin
routes and anonymous legacy demo previews remain separate surfaces.

Remaining work: lifecycle service, authentic issuer/agent credentials, approval
authority, row/source permissions, budget reservation, atomic consumption,
receipt reconciliation and rejection-event audit. Database administrator access
can modify membership and schema; immutable triggers are not independent
tamper-proof evidence. Consider D1 read-replication consistency before enabling it.

Validation: Vitest authorization/storage tests plus
`python tests/control-migration.py` for actual SQLite constraints. Run against
local D1 as an additional deployment check before remote rollout.
