# Offline Cancellation Request Restore Comparison

`scripts/check-restore-cancellations.py` compares historical cancellation
requests in two distinct detached SQLite snapshots, for one exact tenant. It
reads the request, dispatch claim, deterministic job binding and intent, not a
current-owner eligibility view. Removing ownership or withdrawing a delegation
therefore does not hide an old request from the comparison.

```sh
python -B scripts/check-restore-cancellations.py --restored restored.sqlite --reference retained-later.sqlite --tenant tenant-id
```

Both inputs need the cancellation provenance columns introduced by migration
0034, including when the selected tenant has no requests. This tool does not
migrate an input; an older schema is unsupported, not an empty inventory. It
does not authorize any production migration or database restore.

Use separately retained, quiescent, standalone rollback-journal-mode copies.
The shared reader rejects missing or repeated files, hard links to the same
file, WAL-mode headers and journal/WAL/SHM sidecars. Connections use
`mode=ro&immutable=1`, `query_only` and disabled trusted-schema functions. Never
point it at live files or files another process may change. No credentials,
provider requests, repair writes or network services are used.

The checker requires a matching same-tenant claim, binding and intent for every
request, using explicit binary identifier equality even if a snapshot's column
collations were changed. It recomputes the job ID and action tag, checks the stored pending
receipt ID, positive safe-integer byte cap, matching audience/body-digest pins,
and valid request/claim timestamps with the request no earlier than the claim.
It compares original actors, timestamps and binding fields, not just totals.
Requests with both delegated provenance fields NULL are retained and counted
as unattributed when their claim is delegated. Partial or mismatched attribution
is rejected. Non-delegated claims must have no delegated request provenance.

Output reports counts only: added, lost and changed records, plus attributed
delegated, unattributed delegated and non-delegated request counts for each
snapshot. It does not print tenant/actor IDs, file paths, job addresses, digests,
SQL or receipt bodies. More than 10,000 selected joined rows is an error, never
a truncated comparison. Errors give a generic diagnostic and no partial report.

- Exit `0`: selected request records and their checked bindings match.
- Exit `1`: requests or checked bindings differ between the snapshots.
- Exit `2`: arguments, schema, scope, file boundaries or record bindings are
  unusable; no comparison was made.

Every report sets `issuerAuthenticated`, `cancellationConfirmed`,
`retryAuthorized` and `servingAuthorized` to false. Equal empty backups can both
omit a later request. A request is not proof of sending, provider receipt,
cancellation, causation or zero/final cost. Identical modified copies are not
independent custody evidence. Full receipt/audit integrity, current authority,
compiled-body authenticity and final billing are separate checks. Use the
[request export verifier](CANCELLATION_EVIDENCE.md),
[settled receipt/dispatch restore checks](SETTLED_EVIDENCE.md) and
[cost comparison](COST_RESTORE.md) for their distinct scopes.

Regression coverage in `tests/restore-cancellation-provenance.test.ts` uses
actual migrated synthetic databases, before/after-request copies, a pre-upgrade
request, withdrawn owners, terminal observations and a final synthetic bill.
Restoration preserves both snapshot bytes and the recorded request export.
Adversarial copies test changed attribution, malformed links and file/schema
boundaries. These checks are not independent sign-off or a production drill.
