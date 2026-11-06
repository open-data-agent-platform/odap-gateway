# ODAP Gateway Workers Deployment

This package is prepared for Cloudflare Workers with D1 and static assets.

## Native storage verification

Run `npm run test:native` before release. On Windows select an installed Node
24.22.1+ executable in the 24.x line with `ODAP_TEST_NODE`. The gate runs all native
D1 test files without filters and checks process completion plus report coverage;
a partial JSON `success:true` is insufficient. See
[native D1 verification](NATIVE_D1_VERIFICATION.md) for evidence paths and limits.
This uses local temporary databases and does not perform production migrations.

## Local setup

```bash
cp .dev.vars.example .dev.vars
cp wrangler.example.jsonc wrangler.jsonc
npx wrangler d1 create odap-gateway-db
npx wrangler d1 execute odap-gateway-db --file=db/schema.sql
npm run build
npx wrangler deploy
```

## Required bindings

- D1 binding: `ODAP_GATEWAY_DB`
- Static assets binding: `ASSETS`

## Hosting under a path

To mount the Gateway at `https://googlesql.com/gateway`, build with
`NEXT_PUBLIC_GATEWAY_BASE_PATH=/gateway` and
`NEXT_PUBLIC_GATEWAY_ORIGIN=https://googlesql.com`. Set the Worker variable
`GATEWAY_BASE_PATH` to the same `/gateway` value. An empty/unset path preserves
standalone root hosting. The build-time prefix applies to Next links/assets and
browser API requests; the Worker routes the prefixed APIs and assets and keeps
same-origin redirects under that mount. Rebuild when changing the prefix.

Use a path Route, not a Custom Domain, and leave the existing site's DNS and
Worker binding intact. Cloudflare route matching includes query strings, so the
production route is `https://googlesql.com/gateway*`. The Worker only handles the
complete `/gateway` segment and its descendants. Set
`GATEWAY_SITE_ORIGIN=https://googlesql.com` to pass sibling matches such as
`/gateway-other` unchanged to the existing site origin; other hosts fail closed
outside the mount. Verify that this origin is already served by the intended
site and that no route being replaced belongs to another Worker. Keep
`assets.run_worker_first: true` and verify main-site responses before and after
deployment. Do not bind the site's existing database to this Worker.

Register provider callbacks with the prefix, for example
`https://googlesql.com/gateway/api/auth/callback/google`. Registration alone does
not enable login: provider credentials, the session secret, empty-store bootstrap
and an explicitly chosen administrator still need their corresponding setup.
Path hosting shares the site's browser origin; it is not an origin-isolation
boundary. Dedicated Gateway cookie names remain unchanged, including the
host-only OAuth `__Host-` cookie whose required `Path=/` is retained.

## Static asset authentication

Keep `assets.run_worker_first: true` in every deployment configuration. Cloudflare
otherwise serves matching static files before the Worker, bypassing its admin-page
authentication and response headers. This also applies to exported HTML and Next
flight-text files. The Worker checks decoded admin paths before fetching assets;
encoded aliases must not skip the gate. Public assets still receive security headers.

`tests/worker-assets-miniflare.test.ts` bundles the actual Worker with a local
Wrangler dry run and exercises the installed native asset router. Its explicit
asset-first counterexample returns the private shell without authentication; the
configured Worker-first path redirects anonymous GET/HEAD requests to login and
refuses a cookie without canonical storage. This is local routing evidence, not
proof of an existing deployed configuration. Worker-first requests invoke the
Worker and count against that account's applicable Workers limits.

## Empty administrator storage

`db/schema.sql` and runtime administrator initialization create empty tables.
They do not insert demonstration flags, workspaces, schema catalog entries,
review approvals or query runs. Binding a database, logging in or reading the
dashboard does not provision those examples. Real configuration must be supplied
through separately authorized workflows; a fresh bound catalog is empty.

Each runtime CREATE requires an affirmative storage acknowledgment before the
next statement or caller operation. A failure stops the request without a
secondary-binding fallback or automatic retry. Earlier empty tables can remain
after partial initialization, and a later request can resume idempotently. This
does not validate the full shape of an existing table or confirm every legacy
write response.

Dashboard list reads (users, flags, workspaces, reviews, tables, fields and audit
events) require affirmative success and an array of results. An empty array is
valid; missing or unsuccessful results are not an empty persisted state. A failed
list stops the entire dashboard response. Both table and field lists must load
before the policy catalog can be returned or evaluated. There is no partial
catalog, retry or binding fallback; SQL errors remain visible as request failures.
These checks do not validate every stored row value or provide one transactional
snapshot across the separate reads.

Existing rows, including former-example IDs and later edits, are neither deleted
nor reset. Previously installed examples need a separately authorized review;
removing automatic seeding is not a cleanup migration. The no-storage preview
remains explicitly marked `seed`, and static release-track descriptions are not
deployment evidence. Governed contracts and authorization checks are unchanged.

## Administrator authority

The legacy admin API and private pages require both a valid admin session
and a current `users` row with the same provider/subject, canonical user ID
and `admin` role. A cookie role or `ADMIN_EMAILS` match alone is insufficient.
After a stored demotion or deletion, subsequent old-cookie requests are
denied. A missing binding, missing users table or authority-read failure
returns 503 (`admin_authority_unavailable`), not an offline admin preview.
The authority check does not initialize tables, create users or repair
legacy identity mismatches. Provisioning and login persistence must be
healthy before admin access. If both bindings exist, `ODAP_GATEWAY_DB`
takes precedence; failure does not fall back to `DB`.

This shared guard is a request-entry check, not atomic authorization of every
in-flight legacy mutation. Role and schema-field policy updates add the
write-time guards below.
It does not revoke the identity session itself
or replace the tenant control store's separate membership checks. The
session display may retain its login-time role until a new login.

Role updates also check the administrator's canonical ID, provider, subject,
current role and audit contact inside the same SQL statement as the mutation.
The target role must still equal the role read by this request. An intervening
demotion, identity/contact change, target removal or differing target role
returns 403 (`admin_user_update_denied`) without a role update or success audit.
Refresh authority and target state before making another explicit decision;
do not automatically retry a denied grant. Self-demotion is refused by
provider-subject identity rather than contact email. Success returns the
actual changed row, not a reconstructed result for a missing user.

Role updates require the selected binding's transactional `batch` API;
without it they return 503 (`admin_role_transaction_unavailable`) before
schema initialization, with no fallback to a second binding. An audit insert,
the guarded role update and a SQL consistency assertion run in one transaction.
Both actor and target contact must still match the audited snapshot. The role
update requires exactly one newly inserted audit, not just an existing event ID.
If an event exists but its update is skipped, the batch aborts with HTTP 500.
An ignored audit insert without a collision returns 403 without a role change.
The operation never deletes audit rows; a colliding ID combined with a skipped
insert cannot reuse or remove the historical event, even after authority loss.

A lost transaction acknowledgment can still mean both writes committed.
The API does not retry automatically: reread roles and audit evidence before
making another explicit decision. This is not an idempotent command protocol,
a revocation epoch, or proof that other legacy mutations have atomic audits.
The guarantee assumes the database's transactional batch contract; local
SQLite and Miniflare checks are not production acceptance or retention proof.

Schema-field policy updates similarly require transactional storage (503,
`schema_policy_transaction_unavailable` if absent). The transaction binds the
current administrator identity, role and audit contact to the complete field
row read by the server, including table association, name, type, mode, flags
and revision time. Changed authority or a changed/deleted field is refused
with 403 (`schema_field_update_denied`); refresh before a new explicit decision.
It does not reconstruct a successful response for a row that was not updated.

The policy change and its audit commit together. The audit records table/field
identity and the previous and new `queryable`/`pii` flags. Like role updates,
the policy update requires a newly inserted event and a consistency assertion
rolls back an event with no matching update (HTTP 500). This path never deletes
audit rows, including on an ignored insert plus a historical ID collision.
Missing batch support does not initialize schema or fall
back to another binding. Lost acknowledgments remain uncertain and are not
automatically retried. This protects the server's in-flight snapshot, not a
revision supplied by the browser: the API has no stale-page revision token.
This legacy catalog operation neither publishes a Semantic Release nor grants
tenant execution authority. Other legacy mutations require separate review.

Feature-rollout changes also require transactional storage; without batch
support they return 503 (`feature_rollout_transaction_unavailable`) before
schema initialization and without fallback to another binding. At the write
boundary the actor's current canonical identity, admin role and email must
still match, as must the complete server-read flag row. A changed/deleted flag
or lost authority returns 403 (`feature_rollout_update_denied`); refresh before
making a new explicit decision. The response is the row returned by storage.

The rollout/status update and audit are committed together. The event records
environment, owner, and previous/new rollout and status. The update requires
one newly inserted event, not merely an existing matching ID. If an event exists
but its flag update is skipped, a SQL assertion aborts the batch (HTTP 500).
The operation never deletes audit history, including when an ignored insert
coincides with an ID collision. A lost acknowledgment may mean both writes
committed: the server does not retry automatically. This is not exactly-once
execution or stale-browser revision protection. Changing a legacy feature flag
does not issue an Approval Contract or prove a production feature deployment.

Legacy run-review changes require batch support in the selected binding (503,
`run_review_transaction_unavailable` otherwise). Current canonical actor identity,
admin role and email are checked with both complete server-read records inside
the transaction. An in-flight authority or record change returns 403
(`run_review_update_denied`). A missing query detail or pre-existing mismatch in
workspace, status, cost or scanned bytes returns 409 (`run_review_inconsistent`);
the operation does not repair or approve that mismatch. A missing review is 404.

The query status, review status and required audit commit together. Ignored or
failed status writes abort the batch (HTTP 500), preserving both original records
and prior audit history. The event records the previous/new status, workspace,
query type, mode and estimates, without copying SQL or query results. Successful
responses map the actual returned review row. Lost acknowledgment can still mean
all three writes committed; there is no automatic retry or exactly-once command
ID. The snapshot is read during the server request, not bound to an earlier
browser inspection. This legacy decision neither issues an Approval Contract
nor admits a governed execution.

Docs-feedback review requires batch support in the selected binding (503,
`docs_feedback_transaction_unavailable` otherwise), before schema initialization
and without binding fallback. The transaction rechecks the canonical actor's
current admin role and email against the complete raw server-read feedback row,
including its question, author fields and nullable answer attribution. A changed
or deleted snapshot or lost authority returns 403 (`docs_feedback_review_denied`);
a record already absent at the initial read returns 404. Refresh before making
a new explicit decision.

Moderation status, answer attribution and required audit commit together. The
audit records previous/new status and answer-presence/change flags, not the
question, answer or author's email. Skipped audit insertion cannot authorize an
update; a skipped update with an audit aborts the batch (500), as do failed writes
and historical audit-ID collisions. No audit history is deleted. Success returns
the actual stored row. Lost acknowledgment may leave both writes committed; the
server does not retry automatically. This is not a browser revision token,
exactly-once protocol, execution grant or proof of semantic correctness.

The feedback schema helper and installation SQL no longer insert demonstration
questions or answers. Public and admin reads return only stored rows; an empty
public result stays empty even when pending records exist. With no binding,
reads return an empty list with `persisted: false`, not sample content. Failed
or unconfirmed configured reads do not become successful empty results. Valid
submissions without a binding return 503 (`docs_feedback_storage_unavailable`);
there is no preview acceptance. A configured submission must return its inserted
ID before success is reported; skipped or failed writes fail the request.
The anti-spam honeypot still discards submissions without storing them.

Existing records, including seed-named records that may have been edited, are
not automatically deleted, hidden or rewritten. Previously installed examples
need an authorized content review; this is not a cleanup migration. The separate
administrator storage boundary above also removes automatic example insertion
from other legacy tables, without cleaning their historical records.

Feedback initialization requires confirmed table creation and column metadata.
It only adds missing answer columns, checks each DDL acknowledgment and verifies
the resulting column set. Invalid metadata, missing base columns and failed DDL
stop the feedback operation; they do not trigger a secondary binding or an
automatic retry. Current schemas avoid duplicate ALTER attempts. Existing
feedback and answers are not rewritten. Partial additions may remain after a
failure, and a later request inspects again before resuming. A stale concurrent
legacy upgrader can return an error even if the other upgrader succeeded.
These are column-presence checks, not a full schema-constraint or corruption
validator. They do not authorize a production migration.

The feedback browser now shows separate loading, unavailable and confirmed-empty
states, with an explicit reload control. Only a confirmed persisted list of
well-formed approved records is displayed. It neither falls back to examples
nor inserts a pending submission into the public list. Unexpected server fields
are excluded from UI state, including an author's contact address.

A submission requires an HTTP 200 response with explicit accepted, pending-review
and persisted flags, a recognized binding and a valid pending record. Network
errors, refusals, redirects, invalid bodies and preview/honeypot acknowledgments
retain the draft instead of reporting success. Inputs are locked while a request
is pending and duplicate sends are blocked. List reads and submission notices
have separate state; a late read cannot erase a confirmation. Errors/statuses
are announced accessibly and raw server diagnostics are not displayed.

Draft retention is in memory, not across refresh/navigation. A lost acknowledgment
can still mean the server committed; no automatic retry or exactly-once protocol
is implied. Local browser fixtures do not prove a deployed service or independent
production acceptance.

Login persistence is keyed by provider and subject, not email. For an
existing identity, login updates profile/contact data but never its role
or identity fields. `ADMIN_EMAILS` supplies an initial role only when
creating a new identity; changing that list is not a stored-role revocation.
Use the explicit role-change operation to demote an existing administrator.
Deleting a row is not a permanent login ban or a revocation tombstone.
An email already held by a different identity is a conflict, not permission
to link accounts. There is no automatic account-linking or legacy-row repair.

The OAuth callback issues no new session if user persistence is unavailable,
conflicted or its required audit write fails. It redirects with
`auth_user_persist_failed`; storage error details are not logged. The selected
binding must support atomic batch execution; absence fails before user schema
initialization with no fallback to another binding. User upsert and required
login audit commit together. The audit requires a real user write and reads the
actual stored role, not the incoming allowlist role. A failed or skipped write
rolls back both account/profile changes and audit, including audit-ID collisions.
Historical events are never deleted by login.

This transaction does not include OAuth-state consumption, provider exchange,
session signing or delivery to the browser. A lost commit acknowledgment can
leave both user and audit persisted without a new session; the callback does
not retry. The consumed OAuth state remains unusable, so start a new login.
The `auth.login` event records successful persistence after provider verification,
not proof that the browser received a cookie. Subsequent login still preserves
the stored role. There is no distributed exactly-once login guarantee.

Before any account write, Google must explicitly return boolean
`email_verified: true` with its email and subject. GitHub must return
exactly one `primary: true, verified: true` contact from `/user/emails`,
using the same access token as the profile request. The public profile
email and a constructed noreply address are not fallbacks. Emails are
trimmed/lowercased consistently before role lookup and persistence.

A missing verification flag, missing/blank contact, ambiguous primary list
or failed contact request ends login without a new session or user write.
For GitHub, the existing login request includes `user:email`; deployments
still need the relevant provider permission/consent. These paths have only
been tested with intercepted provider responses locally. No live OAuth
consent, provider configuration or external acceptance is asserted here.

### Provider exchange confidentiality

Token, profile and verified-email requests use fixed provider endpoints with
manual redirect handling. A redirect or other non-success response ends login;
its body is discarded without parsing and credentials are not forwarded to the
redirect destination. This follows the Workers
[manual redirect guidance](https://developers.cloudflare.com/workers/runtime-apis/request/#properties).

Callback failure logs contain only `oauth_callback_failed` and the provider name.
They omit raw exceptions, which can include token/profile response fragments.
An operator must not add raw response bodies or exception messages when diagnosing
this event. A failed exchange creates no new session or account and requires a
fresh login after the single-use state was claimed. The regression tests use
synthetic responses and a loopback HTTP server, not a live provider login.

### Provider response bounds

The five Google/GitHub login endpoints share `lib/oauth-provider-json.ts`,
which uses the same bounded reader/deadline as job observation through
`lib/provider-response.ts`.
Each request has a fixed 256 KiB response ceiling and a 15-second deadline
covering headers and body consumption. The reader counts actual streamed bytes
even when `Content-Length` is absent, invalid or understated; a declared excess
is refused before reading. JSON is decoded with strict UTF-8 validation. These
are Gateway transport policy limits, not claims about provider requirements.

The deadline aborts the request and cancels an active reader without awaiting a
potentially stalled cancellation. Late headers are discarded; no automatic retry
or continuation to account persistence is allowed after refusal. Timers and reader
locks are released. Existing verified-email checks and the one-time state rule
remain unchanged, so a refused callback requires a fresh login attempt.

This is a per-endpoint limit, not a total callback or database deadline. Google
uses two sequential provider requests and GitHub uses three. The separate
BigQuery service-account token exchange also uses this reader after signing,
but query/submission/observation responses still have separate open bounds.
See the [token boundary](BIGQUERY_GOVERNED_TRANSPORT.md#service-account-token-boundary).
Local stream/fake-clock tests and actual Workers stalled-stream tests
cover the policy; they do not replace real-provider consent or pilot acceptance.

### Browser-bound, single-use login state

Apply migration `0032_oauth_login_states.sql` to the configured auth database
before enabling this login flow. Start/callback do not create this table.
Unavailable state storage redirects with `oauth_state_unavailable` and
does not fall back to an unbound flow or issue an identity session.

Login start sets a random HttpOnly, SameSite=Lax, ten-minute binding cookie.
HTTPS uses the host-only `__Host-odap_gateway_oauth` Secure cookie; HTTP
is supported only on loopback for isolated local development, using a
separate cookie name. A later login start in the same browser supersedes
the earlier cookie. Host, scheme, provider, expiry, signed-state digest
and browser-secret digest must all match the stored challenge.

The callback atomically deletes that matching challenge before provider
I/O. Provider denial, failed exchange or persistence failure requires a
fresh login. Invalid/mismatched callbacks do not consume a valid challenge
or clear its binding cookie. Completed claims clear the binding cookie;
this is not a logout of any previously existing identity session.

Unconsumed expired rows are refused but not automatically purged.
Operators need a separately approved retention/rate-limit policy before
public exposure. Local SQLite/Miniflare checks do not establish production
retention, restore/replay behavior, or real-provider acceptance.

## Secrets

Malformed percent encoding or duplicate identity-cookie names are treated
as unauthenticated, not as a server error or a choice of the first identity.
Cookie collisions across legacy paths may therefore require clearing the
conflicting browser cookies before a new login. An unrelated malformed
cookie does not discard an otherwise valid, unambiguous identity session.

Store OAuth client secrets, cookie signing values, and BigQuery private keys as
Worker secrets or local `.dev.vars` values. Do not commit real values.

## BigQuery

Grant the service account the minimum permissions needed for dry-run jobs and
metadata reads over the datasets you want ODAP Gateway to govern.

The legacy SQL editor cannot submit a raw BigQuery preview in production.
Even a signed-in owner with a configured database and credentials receives
HTTP 403 (`production_preview_scope_unbound`): neither the workspace field
nor the SQL proves which tenant owns a referenced table. This path never
falls back to simulated production success. Do not relax the deployment
mode to work around the refusal. This restriction does not disable the
separate governed execution path.

In an isolated demo, explicitly setting `GATEWAY_MODE=demo` allows a
signed-in live preview. Without a gateway mode a would-be live request
returns HTTP 503. Uncredentialed local estimates and explicitly simulated
demo previews do not call the warehouse. A dry run is not an execution grant.

The legacy editor's [SQL preview policy profile](SQL_PREVIEW_POLICY.md) uses a
pinned BigQuery syntax-tree parser for a restricted single-table SELECT subset.
Quoted fields and aliases cannot bypass catalog checks; unsupported syntax is
blocked before transport rather than treated as safe. This does not enable
production raw previews or replace the release-bound structured metric compiler.

With a bound database, preview history requires transactional `batch` support.
After the existing authentication and transport gates, the API rejects a missing
or noncallable `batch` with 503 (`dry_run_history_transaction_unavailable`) before
consuming the request body, initializing schema, reading the catalog or invoking
the provider. It checks the preferred binding without falling back to another.
The recorder also checks callability before its own initialization, then writes
the query record, review entry and audit in one batch. A failed or skipped insert
aborts all three, and a colliding review ID is rejected rather than replaced.
Only confirmed matching insert results produce `persisted:true`; without a
binding, the existing estimate remains explicitly `persisted:false`.

Schema initialization and any preceding provider operation are not part of that
transaction. Callability is not a health probe: a later storage failure can still
occur after provider work. A lost or malformed commit acknowledgment fails the request
without retry or deletion, but complete history may already exist. Do not assume
the absence of a success response means nothing was saved; retry idempotency and
recovery are not provided by this change. These are legacy preview records, not
an Approval Contract, execution grant or governed Evidence Receipt.

The legacy admin schema importer submits a BigQuery query, not a dry run.
It is disabled in production and when the mode is absent or unrecognized.
Only an isolated demo with explicit `GATEWAY_MODE=demo` can use that path.
Do not switch a production instance to demo to enable import. A production
metadata import would need separate, tenant-scoped admission and evidence.

The catalog storage importer requires a callable `batch` on the selected binding
and returns 503 (`schema_import_transaction_unavailable`) otherwise, before its
own initialization or catalog writes. It does not fall back to another binding.
All imported tables, fields and the audit event run in one batch. Failed or
ignored writes, ID collisions and a table-ID change since the lookup abort the
whole import. Confirmed matching write results are required for success. Existing
field IDs and fields omitted from reimport remain intact. Reimport preserves
existing restrictions and applies any explicit `pii=true` or `queryable=false`
restriction to an included field inside the same transaction. Less restrictive
inputs and absent/removed policy tags do not clear an existing restriction.
Name-based sensitivity defaults still apply to new fields, but do not override
an existing field's policy on reimport. Changing a restriction explicitly remains
a separate administrator policy operation, not an import side effect.
Import counts describe processed inputs, not the number of newly created rows.

When restrictions are supplied, the import audit's `requestedRestrictions` lists
the table/field and restrictive flags submitted in that batch. It describes the
request, not an old/new policy diff or a claim that every listed field changed.
Raw upstream policy-tag resource names are not added to this audit. The writer
requires returned field acknowledgments to confirm the requested restrictive
flags before reporting success. A missing or inconsistent acknowledgment fails
without a retry or compensating write; the transaction may already have committed.
This does not provide a background freshness check or synchronize later source
changes without a new import. The production importer remains disabled.

The explicit-demo wrapper also checks callable batch support after input
validation but before token exchange, metadata querying or catalog initialization.
Unavailable transactions return 503 without provider work or binding fallback,
even if provider credentials are missing. API auth/JSON checks and invalid-input
responses retain precedence; non-demo requests retain the existing disabled-mode
refusal. Callable bindings still undergo the usual provider configuration checks.
The storage writer repeats its capability check after metadata retrieval.

The internal importer requires the trusted actor's provider, subject and current
stored contact, not an email string. Its admission audit and catalog writes
recheck canonical user ID, provider, subject, admin role and email inside the
transaction. Authority lost before admission returns 403 (`schema_import_denied`)
with no catalog or audit writes. A skipped write after admission, including an
in-batch authority change, aborts the transaction (HTTP 500). Audit collisions
fail without reusing or deleting a historical event. Refresh before a new
explicit decision; do not automatically retry an authority refusal.

Callability does not establish storage health or guarantee a later commit; a
capable binding may still fail after provider work. Initialization and the query
are outside the batch, so this check cannot undo prior provider work.
The complete import must fit one transaction; no
chunked partial-success fallback is used. A lost or malformed post-commit
acknowledgment fails without retry or cleanup, but data may already be committed
and a caller retry may append another audit. This is not a production import
admission path, Semantic Release publication or governed Evidence Receipt.
