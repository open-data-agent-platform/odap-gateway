# BigQuery scan limit at dispatch

Migration 0007 adds **no default price and no default allowance**. A trusted
operator must attest on-demand analysis billing for the actual project and
location, provide a conservative upper-bound price in integer micro-USD/TiB,
a positive per-job byte limit, a pricing evidence reference, and a UTC expiry.
The policy is scoped to tenant, target and approval policy revision. Existing
policies cannot be overwritten: publish new pricing under a new revision and
reauthorize. Withdraw an unsafe policy immediately by changing the current
target policy revision or removing the read grant; do not wait for expiry.

The dispatcher reads the immutable intent's original reservation in micro-USD.
It computes the following using exact integer arithmetic:

```text
affordable_bytes = floor(reserved_micro_usd * 2^40 / micro_usd_per_tib)
maximumBytesBilled = min(affordable_bytes, max_job_bytes)
```

An absent/mismatched/expired policy, unsupported billing mode, unsafe number,
zero reservation, or sub-byte allowance is a denial. A zero-byte cap is never
sent. The final conditional write rechecks authority, reservation and policy
using the database clock, recording the cap on the single dispatch claim.
Old claims have NULL for the unknown historical ceiling. The exact same number
is handed to the trusted adapter as the decimal string
`configuration.query.maximumBytesBilled`. The transport must preserve it; see
[BigQuery JobConfigurationQuery](https://cloud.google.com/bigquery/docs/reference/rest/v2/Job#JobConfigurationQuery).

This limits ordinary **on-demand scan bytes** under the attested price. It is
not a live pricing feed, an invoice guarantee, a quota on other services, or
evidence of a warehouse charge. Capacity billing, external services, model
calls, storage, data transfer, taxes and other charges are not covered.
This development change adds no real submission, warehouse billing detection,
production migration or automated settlement. Tests use a synthetic rate and
a mock adapter, not a published vendor price.
