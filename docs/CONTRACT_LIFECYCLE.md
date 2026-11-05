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
Read-only API scope is unchanged. Agent credential authentication and issuer
services remain future work.

Tests: Vitest plus `python tests/contract-lifecycle-migration.py`. The SQLite
test checks real transition triggers and eight concurrent state claims; D1
integration and external job recovery still require separate validation.
