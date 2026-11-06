# Local Gateway evaluation design

[The v1 manifest](scenarios.v1.json) assigns 100 proposed scenarios to seven
categories. An ID identifies one decision or calculation, not a test run.
The expected result is written before any adapter is measured. No results
are recorded in the manifest. This is not a normative ODAP rubric.

| Category | Cases | What the oracle specifies |
|---|---:|---|
| Numerical correctness | 16 | Exact integer or null and unit; distinguish an empty sum from a zero count. |
| Ambiguity | 12 | Resolve a unique meaning, ask a specific question, or abstain. |
| Lifecycle | 14 | Which revision remains eligible or what immutable record survives. |
| Authorization | 16 | Whether access is allowed, what can be disclosed, and whether dispatch is possible. |
| Approvals | 14 | Whether a specific approval can admit the action, including retries. |
| Costs | 14 | Reservation, settlement, currency, overrun or refusal; units are integer micro-USD unless otherwise stated. |
| Recovery | 14 | Which durable evidence or refusal must survive a retry, restore or conflict. |

**How to read a case.** `given` is a proposed synthetic situation, not a
stored query, invoice or provider response. For example, NUM-13 expects
null cents, not zero, because the selected depot has no non-null amount.
CST-09 expects a hold: a terminal observation plus an estimate still does
not justify a settlement. A denial is not sufficient if the asserted
side effect occurred anyway.

**What is excluded.** No measurements of live BigQuery, real tenant data,
actual provider billing, production latency or comparative vendor scores.
The cases were written in this checkout and are visible to implementers.
They are not an independent holdout, and passing the manifest validator
does not mean the Gateway passed any of the 100 scenarios.

**Before scoring.** Materialize the inputs and evidence assertions, have an
independent reviewer check them for ambiguity and overlap with development
fixtures, and freeze the reviewed inputs, oracles and version before use.
Keep unsupported, blocked and not-run cases visible rather than guessing
answers or counting them as passes. Report numerical answers, invalid SQL
and abstentions separately from control checks; a control bypass must not
be averaged away. Keep execution reports separate from this design.

## Row-level numerical fixtures

The [synthetic inputs](fixtures/numerical.v1.json) contain rows and positional
filter parameters, not answers. The numerical reference test binds those
inputs to SQL in a fresh in-memory SQLite database and checks the resulting
value and unit against the original manifest.

| Case | Reference result | What the fixture distinguishes |
|---|---:|---|
| NUM-01 | 47 cents | The signed toll adjustment subtracts 13. |
| NUM-02 | 3 rows | Only signed inspections count, not all five rows. |
| NUM-03 | 1180 grams | Three rows are present, including one explicit JSON null. |
| NUM-04 | NULL pulses | West selects no rows; the same query for north finds one row and 21 pulses. |
| NUM-05 | 0 rows | An empty shift partition has count zero, unlike its sum. |
| NUM-06 | -245 cents | Two negative corrections outweigh the positive one. |
| NUM-07 | 0 cents | Three non-null transfers balance exactly; this is not an empty sum. |
| NUM-08 | 2 rows | Count both rows even though both readings are null. |
| NUM-09 | 17 parts | Bin code `007` excludes `7` and its 70 parts. |
| NUM-10 | 2 rows | Both route A and inactive status are required. |
| NUM-11 | 45 kWh | Period zero is a valid filter, not an absent parameter. |
| NUM-12 | 18 tickets | Three distinct batches have equal counts; all contribute. |
| NUM-13 | NULL cents | Two matching rows are explicitly null; the 99 cents belong to another depot. |
| NUM-14 | 2 rows | The apostrophe in `O'Brien` is part of the bound string. |
| NUM-15 | 2147483685 bytes | The total is not truncated to a signed 32-bit integer. |
| NUM-16 | 2 rows | False matches neither true nor null. |

Run `npm test -- tests/evaluation-numerical-reference.test.ts` locally with
the existing test dependencies and Python's SQLite driver. This validates
fixture arithmetic only: 16 reference answers checked, zero Gateway
scenarios measured. No BigQuery job or production data is involved.

## Ambiguity inputs

[AMB-01 through AMB-12](fixtures/ambiguity.v1.json) are twelve independent
synthetic conversations, each consisting of a question, the visible metric
catalog, a dimension dictionary and the current session filters. A metric
reference is local to its case. The first term is its business name; the
remaining terms are aliases. A candidate is visible for context but has not
been released. An omitted session filter has no implicit default.

For example, two released metrics accept the term `margin` in AMB-01. In
AMB-12, only a candidate accepts `ripple index`. Those are different
catalog states, not two spellings of the same missing-information problem.
AMB-10 and AMB-11 also include questions with enough context to resolve.

The original manifest holds the expected outcomes: seven clarifications,
three abstentions and two unique resolutions. Do not supply the manifest
or the case ID as part of the question. The fixture checks validate case
coverage, the catalog and session references, and the distinctions above;
they do not attempt to answer the questions.

## Lifecycle inputs

Each of the [14 lifecycle cases](fixtures/lifecycle.v1.json) describes an
isolated starting state and one or more requests, not the state after the
requests. Actors have a tenant, role and active flag. Revision keys identify
the exact definition; a display name is not an identifier. Catalogs give
each tenant's current source revision. Reviews, contracts and historical
receipts point to revisions in that case. Historical times are logical
ticks, not wall-clock timestamps. For the two digest-pinned requests, the
fixture digest is SHA-256 of compact UTF-8 JSON containing `table` then
`unit`; it is not a production Semantic Release digest.

In LIF-03, the request names A while the review names B. In LIF-06, two
distinct actors name the same revision and review in the same concurrent
group; their array order is not an execution order. LIF-10 deliberately
targets the other tenant despite a matching metric name. The input checks
preserve those differences. They do not apply a transition, run a race,
authenticate an actor or score the registry. Expected outcomes remain in
the separate scenario manifest.

## Authorization inputs

The [16 authorization fixtures](fixtures/authorization.v1.json) refer to two
synthetic starting snapshots. Read each case independently. In each snapshot,
membership is scoped by tenant and user, and grants are explicit. An empty
grant list does not erase the distinction between owner and reader. A session
identifies the authenticated operator and, for dispatch, the server-bound
delegated principal and agent. The request is separate: neither an agent
name in its payload nor a foreign billing reference is a credential.

The evidence snapshot intentionally reuses a local intent ID in two tenants
with different receipts and charges. The dispatch snapshot includes a matched
read-only contract, grant and bounded job as a positive control. Two cases
describe changes after the initial check: membership withdrawal during invoice
lookup and policy replacement before the final claim. Neither changes the
starting snapshot for another case.

These are descriptive inputs, not API wire payloads, credentials or evidence
that a bypass was prevented. The tests check references and the precise
differences between scopes; no authorization policy or warehouse adapter runs.

## Approval inputs

[APR-01 through APR-14](fixtures/approvals.v1.json) each start from their
selected contract, the shared synthetic tenant scope and that case's history
only. A request inherits the selected contract ID. Action keys identify an
exact read and release; a second authorized target in the catalog does not
authorize it under the first contract. The action pins are SHA-256 over
compact JSON with sorted keys for the metric-read profile. Definition pins
cover only the synthetic aggregate, column and table, not a production
release. The fixture checks recompute both without the Gateway compiler.

Times are logical ticks. The trusted decision time is separate from any
caller-supplied timestamp or claimed expiry. Requests in the same group
are concurrent, not ordered. An admission recorded in history is an input
fact: replaying its intent differs from presenting a fresh intent against
the already consumed approval. None of the fixture checks actually issues,
revokes or consumes a contract, reserves funds or measures enforcement.

## Cost inputs

The [14 cost cases](fixtures/costs.v1.json) are independent starting states
for one synthetic tenant and budget. Unless a case explicitly changes one,
non-cost admission prerequisites are assumed satisfied. Opening amounts and
reservations are integer micro-USD. Held amounts are listed per intent;
`posted` lists prior final charges already included in opening spend. The
requests have not been applied to those balances. A job alias resolves to
the tenant, project, location and job ID; a bill reference is not a job ID.
Price validity is expressed in logical ticks, not wall-clock timestamps.

CST-03 through CST-05 keep the same cancelled job, measured bytes and
reservation. Only the billing evidence changes: absent, 3 micro-USD final,
or zero final. CST-12 replays an already posted invoice; CST-13 reuses its
reference for another job in the same tenant. The checks verify those
differences and independently calculate balances and potential overruns.
They neither run the Gateway ledger nor attest to billing-provider behavior.

## Recovery inputs

Each of the [14 recovery cases](fixtures/recovery.v1.json) lists the records
present at the start of that case, then a new attempt. A shared record not
named in `stored` is absent from that history. Event times are logical ticks;
in the settled specimen they correspond to seconds past 10:00 UTC on October
10, 2026. The job alias `kiln` refers to the specimen's pinned job identity,
not to an acknowledged submission. In REC-12 the receipt insert is an
uncommitted transaction step, not a recovered final receipt.

The [settled specimen](fixtures/recovery-settled.v1.json) and its
[test pin](fixtures/recovery-settled.v1.sha256) are synthetic. The pin covers
compact UTF-8 JSON with recursively sorted keys, not the indentation or line
endings of the source file. REC-07 changes the final receipt ID without a
pin to isolate the broken link. REC-08 changes both monetary records while
retaining the original pin. The pin models a previously retained digest,
not a trusted signature. No recovery attempt is executed by the input tests.

## Input inventory complete

All 100 declared IDs have a local input in their declared category. The
113 fixture checks validate those inputs and their reference calculations;
they are not 113 Gateway decisions, nor an accuracy or bypass score. The
next gate is independent review for oracle quality, overlap and exclusions,
followed by a decision on freezing the benchmark. No publication, scoring
run or pilot is implied by completing this inventory.
