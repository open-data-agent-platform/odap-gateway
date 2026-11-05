# Evidence coverage of recorded attempts

`readEvidenceCoverage(access)` takes one read-only SQLite snapshot and
returns counts only. An active tenant owner receives zeroes for an empty
tenant. A missing tenant, non-owner or inactive membership returns `null`,
not a zero-activity report. No warehouse, billing provider, migration or public
endpoint is involved.

There are two denominators. **Recorded attempts** are the sum of durable
missing-release refusals and admitted execution intents. **Admitted** counts
only execution intents; a pre-approval refusal is not an admission. Requests
that never reached durable storage and other classes of pre-approval refusal
are outside both counts. This is not a fraction of all inbound traffic.

Each admitted intent belongs to exactly one bucket:

| Field | Evidence present in the same tenant |
|---|---|
| `pendingOutcome` | Bound pending receipt, no recorded terminal observation, bill or settlement. A prepared job need not have been dispatched. |
| `pendingBilling` | Bound pending receipt and terminal observation on a bounded claim, but no final bill or settlement. Zero measured bytes is not a zero charge. |
| `attributedSettlements` | Bounded claim, linked pending and final receipts, matching job outcome, bill reference record and matching ledger settlement (including an explicit zero). |
| `unattributedSettlements` | Settlement with a linked terminal receipt but no per-job bill record. This includes legacy data; it does not establish when the settlement was created. |
| `missingEvidence` | No qualifying chain, including a newly admitted intent not yet prepared or conflicting monetary links. This is a gap to inspect, not a claim of data loss. |

The five buckets sum to `admitted`. The observation lookup chooses at most
one immutable sample per intent, so byte-count enrichment, repeated
reconciliation and refusal retries do not change the denominators. A standalone
receipt or job identifier is not counted as a new attempt.

The attributed bucket checks relational linkage, not a signed invoice, an
independently pinned checksum, the full receipt wire shape or the presence of
every audit event. Use the [settled evidence verifier](SETTLED_EVIDENCE.md)
for a specific exported bundle. No monetary totals or tenant identifiers
are returned by this inventory.
