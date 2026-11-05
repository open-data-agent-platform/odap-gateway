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

Role policy: reader/reviewer/owner may read; only owner is eligible to use the
internal append primitive. Append checks owner membership within INSERT SELECT,
so an earlier access object is not a reusable role grant. The primitive validates
object shape and tenant but is not an issuer, approval engine or execution service.
Do not expose it as a generic public write endpoint. Public writes are absent.

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
