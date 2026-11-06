# Pre-freeze review: three counterexamples

Author investigation, 2026-11-05. Baseline: `645ba76`. No changes to v1
inputs, questions, expected outcomes or denominators. Nothing was frozen.

| Case | Observation on v1 | Proposed discriminator |
|---|---|---|
| NUM-16 | SQLite counts 2 false flags. A wrong query counting explicit nulls also returns 2. | Append one null and update the question's literal list. Correct: 2; faulty: 3. |
| AUT-01/02 | A policy that checks the session's owner role but looks up the requested tenant reproduces both original decisions. | Hold owner, role and intent ID constant; vary only the requested tenant. The faulty lookup returns clay receipt f7 and reef receipt f9; the scoped lookup returns nothing for clay and f9 for reef. |
| LIF-06 | An implementation that never publishes satisfies the literal upper bound. | Given eligible requests, observe committed rows after both finish: exactly one new release, linked to the tenant, revision and approval. At least one success must reference it. Two successes naming it or one success plus a conflict are both acceptable. |

The [proposed changes](amendments.draft.json) are not the scoring key.
The [executable controls](../../../tests/evaluation-prefreeze-review.test.ts)
compare synthetic alternative behaviors, not Gateway benchmark runs.
Before adopting LIF-06 a reviewer must resolve whether the named actors can
promote under the intended policy; a legitimate refusal is not a race failure.

A separate [exporter regression](../../../tests/settled-evidence.test.ts)
calls the actual export function against a local SQLite database. The
same principal is a reader in the resource tenant and an active owner in
another. Neither access context returns that receipt; the resource tenant's
actual owner still gets the complete original export. This exercises the store
boundary, not public authentication, and does not score AUT-01 or AUT-02.

Offline verification: 140 tests passed across ten targeted suites (113
existing fixture checks, three new discriminator checks and 24 exporter
tests including the new tenant-role regression). TypeScript and targeted
ESLint passed. The rest of the Gateway suite was not run for this change.

Independent review, benchmark versioning and a genuinely held-out run remain open.
