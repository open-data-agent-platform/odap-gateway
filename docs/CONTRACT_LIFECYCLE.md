# Contract Lifecycle Foundation

Apply migration 0002 after 0001. It backfills lifecycle state from immutable
contract snapshots and initializes new contracts automatically. Lifecycle
updates append events in the same database transaction. Terminal states cannot
be reactivated. No remote migration has been applied by this change.

The contract GET route now reads effective lifecycle state; missing lifecycle
storage fails closed. Original immutable snapshots remain unchanged.

Internal revokeContract requires current owner membership in its update.
Internal consumeContract performs a conditional single-row claim, checks current
active membership, the original principal and expiration using database time.
Only one concurrent claim can change authorized to consumed. A claim is not
proof of external execution and cannot be reused after a crash.

These functions are not exposed as public mutation endpoints. A future execution
service must validate current release eligibility, agent identity, canonical
action, policy and budget, then couple the claim to a durable execution intent
and idempotent warehouse job. There is currently a gap between those independent
checks and claiming; do not use this primitive alone to authorize real execution.
Migration 0021 adds a [separate issuer](#delegated-contract-issuance-local-development)
for proven agent delegations. Its contracts cannot be consumed by this primitive.

Tests: Vitest plus `python tests/contract-lifecycle-migration.py`. The SQLite
test checks real transition triggers and eight concurrent state claims; D1
integration and external job recovery still require separate validation.

## Check a metric before requesting a contract (local development)

`POST /api/control/{tenant}/metric-previews` checks whether a structured
action compiles against a current, promoted release. Send same-origin JSON
(at most 8 KiB) with a signed session for an active tenant member:

```json
{"releaseId":"revenue-v1","action":{"profile":"odap.metric-read.v1","target":"orders","metricId":"revenue","parameters":{"year":2026}}}
```

A 200 response contains only the compilation summary:

```json
{"ok":true,"preview":{"state":"compiled","releaseId":"revenue-v1","parameterCount":1}}
```

No SQL, parameter values, warehouse identifiers or digests are returned.
Missing, retired, unpromoted and catalog-mismatched releases produce the
same 404. An absent session returns 401; an inactive or nonmember subject
gets 403. The preview makes no warehouse call, estimates no cost and writes
no request, grant or receipt. It is not a prerequisite or reusable approval
for contract intake: intake checks current eligibility again.

## Contract request intake (local development)

`POST /api/control/{tenant}/contract-requests` records a **proposal**, not
an Approval Contract. It requires a same-origin JSON request (up to 8 KiB)
and a signed session with active membership in the tenant. Example body:

```json
{"requestId":"request-1","releaseId":"revenue-v1","requestedAgentId":"reporter","action":{"profile":"odap.metric-read.v1","target":"orders","metricId":"revenue","parameters":{"year":2026}}}
```

Only those four fields are accepted. The service derives the principal from
the session, compiles the action against the promoted definition and checks
the current catalog. It records the canonical action's SHA-256 digest, not
the SQL or parameter values. The requested agent ID names a desired delegate;
it does not prove that agent's identity. The request neither grants a read
nor reserves funds.

With local migration 0018, the first accepted request returns 201 with
`request.state: "proposed"`, the IDs, action digest and database timestamp.
While the release is still eligible, the same tenant/principal/request ID
and identical action, agent and release return the original acknowledgement
(200). Reuse with changed inputs, an unpromoted/retired release or catalog
drift returns 409 without a new write. A later refusal does not erase an
earlier request. Malformed input returns 400; authentication or membership
failure returns 401/403; missing storage returns 503. There is no warehouse
call, issuance, execution or new grant merely because a request exists.

In local semantic review, select a published revision and enter its metric
parameters. **Check compilation** is read-only. To record a proposal, enter
the requested agent ID and explicitly choose **Submit request**. The form
shows the request ID and the inputs actually submitted. Only a response
matching that ID, agent, release and canonical action digest is acknowledged.

After a lost response, **Retry original request** resends the original body
even if the preview parameters have changed. A refusal on retry cannot
disprove a previous insert. This retry state is kept only in the open review
view, not in browser storage; reloading or inspecting again drops the draft.
No retry is automatic. The proposal is not a grant or a warehouse job.

### Recover the original proposal without retrying

In **Approvals > Look up my request**, enter the original tenant and request
IDs. This works after closing the release review or after the release is
retired. The request ID on the submission form also links directly to the
read-only JSON record. Neither lookup resubmits the action.

`GET /api/control/{tenant}/contract-request/{id}` requires a signed session
and current active tenant membership. It reads only the signed-in requester's
immutable intake row. Identical IDs for other requesters or tenants do not
match; an owner cannot use this endpoint to inspect another member's row.
A 200 includes the stored release and requested agent IDs, action digest,
UTC intake time and `recordedState: "proposed"`. It returns no parameter
values, SQL, current grant or execution status. A 404 means no row was
visible at lookup time, not that an in-flight submission cannot still finish.
An inactive member receives 403; storage failures remain unavailable (503).

### Recover a recorded owner grant

**Look up my request** uses the same GET with `?view=grant-history`.
Migration 0019 or later is needed for this view. The plain GET still returns
only the proposal. The expanded read joins the immutable decision by tenant,
requesting principal and request ID while checking active membership in the
same statement. A match adds `grantReference` with only `grantId`,
`grantedAt` and the original `expiresAt`. An explicit `null` means no grant
was recorded at the instant of the lookup, not rejection. A missing view on
an older server or a storage error must not be reported as an absent grant.

Expiry, retirement or a policy change does not erase this history. Looking up
the reference does not renew it, consent to delegation, issue a contract,
reserve funds or dispatch a query. Current authority must be checked separately.

## Human grant (local development)

### Check the reviewed action without granting

`POST /api/control/{tenant}/human-grant-reviews` takes the example body
below **without** `grantId`. It uses a POST so the full reviewed action and
parameter values do not appear in a URL. The read accepts same-origin JSON
up to 16 KiB from a signed-in owner. Only the named release owner can get
a match, and the owner cannot review their own request. Obtain the proposed
action separately: this endpoint compares what the owner supplies; it does
not retrieve another requester's raw inputs or list their history.

On a match the response is `200` with `review.state: "matched"`, the
tenant, named reviewer (`reviewedBy`), requester, request, release, requested agent, policy revision and
server-computed action digest. An absent request, nonmatching action, other
tenant owner, retired release or stale policy produces the same 404. The
response contains neither parameter values nor a grant ID. It records no
decision, reserves no funds and does not establish that a new grant can be
inserted (for example, a decision may already exist).

In local semantic review, inspect the published revision as its named owner.
Set the metric parameters to the values you reviewed, then enter the
requester ID, request ID, requested agent ID and policy revision in **Owner
grant review**. **Check request match** only compares the inputs. Editing a
field, changing parameters or inspecting another revision clears the result.
A client-side owner hint controls visibility, not authorization; the endpoint
checks the signed-in owner and policy again. There is no grant write attached
to this button.

### Record the decision

After a match, **Record owner grant** submits the exact reviewed inputs.
**Close without granting** dismisses the review without writing a denial or
revoking any previous grant. Neither compiling, matching nor closing submits
a grant. The requester can [look up the grant ID](#recover-a-recorded-owner-grant)
for the separate delegation flow; it is not an execution credential.

If the response is lost, the UI reports an unknown outcome. Retry explicitly,
or recheck the original inputs after reopening: the client derives the same
ID from the canonical review scope and checks the tenant, grantor, request,
agent, release, policy, action digest and original ten-minute window in the
acknowledgement. A refusal on retry does not disprove an earlier write.
Expired grants are not renewed. No review parameters go into browser storage.

With migration 0019, the named release owner can record a decision with
`POST /api/control/{tenant}/human-grants`. The signed session supplies the
approver; the requester must be a different, active member. Example body:

```json
{"grantId":"grant-7","requesterId":"google:demo-subject","requestId":"request-1","releaseId":"revenue-v1","requestedAgentId":"reporter","policyRevision":"policy-2","reviewedAction":{"profile":"odap.metric-read.v1","target":"orders","metricId":"revenue","parameters":{"year":2026}}}
```

Send the reviewed action, **not** a caller-computed digest. Canonical hashing
binds its parameters to the immutable request keyed by tenant, requester and
request ID. The conditional insert rechecks the live release/catalog, owner,
requester, configured dispatch target and current read policy for this exact
delegate. The same-origin JSON command accepts up to 16 KiB so a valid 8 KiB
intake action can fit with its review metadata.

A first grant returns 201 and a database-timed ten-minute window. An identical
retry returns 200 with the original times only while the grant is unexpired
and its approval conditions still hold. A different grant ID cannot approve
the same request a second time; submitting a new request is necessary after
expiry. An ineligible or conflicting review returns 409 without recording a
decision. The immutable grant references the request; it does not store raw
parameters or grant new warehouse permissions.

This endpoint records human approval only. It neither authenticates the
delegate nor issues a spendable contract, reserves budget or starts a job.
A later issuer must verify delegation and recheck authority, time and cost;
the historical grant alone is insufficient.

## Requester consent and agent proof (local development)

Migration 0020 starts with **no trusted keys or delegations**. The operator
enrolls a P-256 public key for a tenant/agent/key ID in
`agent_verification_keys` (130 lowercase hex characters for an uncompressed
point). There is no public key enrollment API. A disabled key cannot be
reactivated or replaced. Private keys stay with the agent. Each independent
gateway must configure its own `ODAP_DELEGATION_AUDIENCE` (1-128 ASCII
letters, digits, hyphens or underscores); there is no default audience.

1. The original requester sends a signed-session POST to
   `/api/control/{tenant}/delegations` with
   `{"operation":"create","grantId":"grant-7","agentId":"reporter","keyId":"k1"}`.
   A live matching grant and enabled operator-enrolled key are required.
   The 200 response contains the server-generated delegation ID, expiry and
   exact challenge string. Repeating the same request retrieves the same
   unspent challenge; it does not renew the grant.
2. The agent checks the challenge's purpose, audience, tenant, requester,
   agent/key, release, action digest, policy, project/location and expiry
   against its expected task. It signs the **exact UTF-8 string** using
   ECDSA P-256/SHA-256, not a reserialized JSON object. Use the Web Crypto
   64-byte signature format (r followed by s), encoded as 128 lowercase hex
   characters; DER signatures are not accepted.
3. POST `{"delegationId":"...","signature":"..."}` to
   `/api/control/{tenant}/delegation-proofs`. Both routes require the
   gateway's Origin header, JSON and at most 2 KiB; Origin is not an
   identity credential. The proof route verifies the signature without a
   user cookie. Only the first valid claim returns 201. Wrong, expired,
   revoked or already-used proofs return 403 without disclosing which
   condition failed. No private key or signature is stored.
4. The requester can POST `{"operation":"revoke","delegationId":"..."}`
   to the first route, even after successful proof. Revocation leaves the
   historical proof intact but removes current eligibility. A retry by the
   same active requester returns the original revocation time. The delegation
   cannot outlive the human grant; a new key or delegation after withdrawal
   requires a new grant.

In **Approvals > Look up my request**, a recovered grant shows the agent
from the original proposal. Enter an enrolled **key ID** (never a private
key) and select **Consent to delegation**. Looking up or refreshing the
record does not consent. An expired recorded window has no submit control;
an unexpired one is not proof that policy, membership or key eligibility
still holds. The database rechecks those conditions.

After a verified reply, **Agent signing challenge** shows the exact string
for step 2 above. The UI compares it with the request, grant, release,
agent, chosen key, digest and expiry. The agent must independently check
the intended audience and task before signing. Nothing is sent to an agent
automatically. If the reply is lost or inconsistent, retry explicitly with
the original key; a refused retry is not a revocation or evidence that no
earlier consent exists. No challenge or key selection is stored in the browser
after closing the view.

This is an implementation-local challenge, not an ODAP wire standard. A valid
signature proves possession of the enrolled private key for one approved
action; it does not attest the agent software or the enrollment process.
The proof acknowledgement is not a bearer credential, an Approval Contract
or an execution receipt. No funds are reserved and no jobs are dispatched.
Any issuer must check the recorded proof **and** current delegation authority
under its write lock; the presence of a historical proof is not sufficient.

### Recover a recorded delegation

In **Approvals > Look up my request**, recover the original grant, then
select **Look up delegation**. This reads
`GET /api/control/{tenant}/grant-delegation/{grantId}` on the same Gateway.
The signed-in requester must still be an active tenant member. The read
matches the server's configured audience and the immutable grant; it does
not require that the grant, policy or key is still eligible for execution.

The record contains the delegation ID, enrolled key ID, grant expiry and
the stored proof and revocation times (null if not recorded). It contains
no challenge or signing material. A verified proof and a later revocation
can both be present. Neither a null revocation time nor a recorded proof
establishes current authority. A 404 means no matching record is visible,
not that a previous write was refused. Missing migration 0020 or missing
audience configuration makes the lookup unavailable, not empty. Looking
up or refreshing history never recreates a delegation or revokes it.

### Revoke an inspected delegation

After **Look up delegation**, select **Revoke delegation** and check the
displayed delegation ID. **Keep delegation** dismisses the confirmation;
only **Confirm revocation** sends the existing requester-scoped revoke
command. Expiry, disabled keys and a prior proof are not reasons to hide
this control. An already recorded revocation is not submitted again.

After the one POST, the client rereads history by the original tenant and
grant, even if the POST reply was lost. It reports a recorded revocation
only for the same request, agent, delegation, key and original expiry,
with a stored revocation timestamp and no loss of any previously observed
proof. This confirms the stored state, not who won a concurrent race.
An ambiguous result requires another read before a new explicit attempt.
No signing challenge is displayed alongside a confirmed revocation.
Revoking removes this delegation from further eligible use; it does not
erase proofs or cancel work already dispatched.

## Delegated contract issuance (local development)

After migration 0021 the original requester may send a same-origin, signed-session
POST to `/api/control/{tenant}/contract-issuances`. The JSON body (at most 2 KiB)
has exactly one field: `{"delegationId":"..."}`. A proof acknowledgement or an
agent ID alone is not authorization to call this endpoint.

The issuer checks both the recorded proof and current delegation for the
configured audience, tenant and requester at the write. It derives the existing
v0.1 `data.read` contract fields from the approved metric, request and grant.
The contract expires with the grant; the server allocates the contract and
reservation IDs. The issuance link, contract snapshot, initial lifecycle
state and audit events commit together or not at all.

A first issuance returns 201 with `issuance.delegationId`,
`issuance.contractId` and a tenant-scoped contract `Location`. Repeating the
same request after a lost confirmation returns 200 with the original IDs
only while both the delegation and contract remain eligible. Conflicts,
revoked or expired authority, and missing proof yield 409, not a replacement
contract. Failure to confirm a database write (503) does not prove it failed.
An earlier committed contract remains part of the historical record.

**No execution or funds are authorized by this response alone.** The
reservation ID is not a funded reservation. Database guards reject direct
consumption and caller-priced execution intents for these issued contracts.
Migration 0022 adds a [separate budget admission command](BUDGET_INTENT_ADMISSION.md#delegated-admission).
A contract GET reports the recorded lifecycle state, not live delegation
eligibility or permission to dispatch.

### Issue from requester history

In **My contract request**, inspect the request and look up its delegation.
For a proven, unrevoked delegation within its original expiry, **Issue
Approval Contract** sends just the inspected delegation ID. Opening or
refreshing history sends no issuance command. The server, not the browser
clock or historical proof, decides current eligibility.

The page displays a contract ID and its recorded lifecycle state only after a
matching acknowledgement and an authenticated read. It checks the tenant,
contract ID, human grant, agent, semantic release, action digest and expiry.
It never follows an arbitrary response URL. A refusal describes this attempt,
not whether an earlier issuance committed. A lost or mismatched reply leaves
the command unverified. Use **Look up issued contract** before considering
a deliberate retry; recovering an existing ID never requires another POST.
Neither the write nor the follow-up read admits budget or dispatches a query.

### Recover an issued contract ID

From the inspected, proven delegation, **Look up issued contract** sends
`GET /api/control/{tenant}/delegation-issuance/{delegationId}`. It works after
grant expiry or delegation revocation. It reads the immutable issuance link
for the original requester and configured audience, subject to current tenant
membership. Another tenant member (including an owner) cannot use this lookup
on the requester's behalf. The response contains only tenant, delegation,
grant, request and contract IDs; it does not attest current contract state,
execution authority or reserved budget. Use contract inspection for the
recorded lifecycle state.

A 404 means no matching issuance is visible, not proof that a previous
command failed. Missing configuration or migration 0021 yields 503, not an
empty result. A refresh that fails does not retain a previously displayed ID.

## Local inspection

From Approvals, open `/approval-contract` and enter the tenant and contract
ID. The page uses the existing authenticated contract GET; readers, reviewers
and owners retain their existing tenant-scoped access. A missing record is
distinct from an unauthorized read. The lookup neither stores IDs in the page
URL nor displays principals, agents, reservation IDs or approval references.

The page shows the effective recorded lifecycle (including consumption or
revocation) separately from expiry as of lookup on the browser clock. For
example, a contract may read **Authorized** and **Expired** at the same time.
Execution eligibility is always **Not assessed**. This read neither authorizes
dispatch nor changes the contract, the wire schema or the execution guards.
