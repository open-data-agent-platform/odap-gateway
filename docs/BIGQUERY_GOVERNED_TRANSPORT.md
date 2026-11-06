# Governed BigQuery transport (local development)

The only entry point in `lib/bigquery-governed-transport.ts` takes a prepared
intent, authenticated server context and metric action. It goes through the
dispatch gate. There is no endpoint accepting arbitrary SQL or an assembled
job payload, no default fetch implementation and no environment or credential
discovery in this wrapper.

- Before claiming: validate authority, compile the released definition,
  obtain the injected token, build the request. Authentication failure leaves
  the claim available; failed preparation cannot issue a warehouse POST.
- At the claim: recheck current authority, pricing expiry and reservation.
  Previously claimed intents are lookup-only. The stored byte ceiling is the
  lower of the reservation-derived limit, policy cap and mandatory transport cap.
- After the claim: invoke the trusted, non-retrying sender once. POST to the
  fixed BigQuery jobs endpoint with the pinned reference, action label, named
  parameters and decimal byte ceiling. Redirects are forbidden. The request
  carries a timeout signal; an integrated sender must honor it. A separate
  deadline also bounds acknowledgment waiting if the sender ignores that signal.
- A matching query job reference, label and echoed ceiling on a successful
  response mean **accepted**, not completed or billed. HTTP errors (including
  duplicate job), timeouts, bad JSON or mismatched metadata require read-only
  observation using the existing job identity. Never submit a new job or
  release the reservation on this basis.

Offline integration fixtures use a synthetic token, SQLite and an injected
sender. No live warehouse/API credentials were used or configured. This is
not production evidence or a public submission route. The integration that
supplies the transport must establish identity, supply a trusted definition
loader, avoid logging tokens or query parameter values, and never retry the
POST inside the sender. Terminal evidence and billing reconciliation are
separate from the submission acknowledgement.

## Bounded submission acknowledgment

The acknowledgment reader uses the shared provider response boundary: 256 KiB
of actual UTF-8 response bytes and one 15-second deadline across headers and body.
The deadline starts after the durable dispatch claim, immediately before the
single sender call. Preparing the immutable request and obtaining credentials
still happen before the claim. This does not bound database work, compilation
or an arbitrary injected token supplier.

Oversized, invalid UTF-8, missing or malformed responses and stalled streams
return `observation-required` with the original job reference. The claim and
reservation are not released, and no automatic send retry occurs. Non-success,
already-followed and late responses are discarded without awaiting cancellation.
A timeout is not proof that the warehouse rejected or cancelled the job.

Synthetic unit tests cover byte/declared-length boundaries, late headers and a
shared header/body deadline. SQLite tests retain the claim and reservation after
an oversized acknowledgment and refuse replay. Native Workers tests include an
actual stalled response stream. None of these tests submit a real warehouse job.

## Workers redirect compatibility

Submission and read-only observation use `redirect: "manual"` and reject 3xx
responses without following `Location`. Workers rejects `redirect: "error"`
while constructing the request, before a sender can operate; see the
[Workers Request reference](https://developers.cloudflare.com/workers/runtime-apis/request/#properties).
An integrated sender must preserve the supplied redirect mode, not replace it
with `follow`. Browser-side clients have a different runtime and are unchanged.

`tests/bigquery-transport-miniflare.test.ts` bundles the actual transport modules
with the installed Wrangler bundler and runs them inside local Workers. All
outbound requests are intercepted. Its isolated fixtures replace the claim gate
and credential acquisition, so these tests prove runtime request/response behavior,
not authorization or a real warehouse integration. Separate SQLite-backed
submission tests check the real claim: redirects leave the reservation intact,
produce observation-required status, and cannot rearm or retry submission.
Observation redirect tests issue one GET only; not-found is not a new grant.

## Service-account token boundary

The shared `createBigQueryAccessToken` helper posts its signed assertion only to
the fixed Google OAuth audience with manual redirect handling. Non-success and
already-redirected responses are discarded before parsing. Successful responses
must contain a nonempty visible-ASCII token suitable for a Bearer header. Signing,
network and parser failures produce one static error without upstream details or
logging. There is no automatic retry. The observation and legacy preview/import
callers cannot issue their BigQuery request after token acquisition fails.

`tests/bigquery-token-miniflare.test.ts` exercises the real helper, signing and
fetch implementation in local Workers with an ephemeral synthetic RSA key and
fully intercepted outbound traffic. Redirect cases include 307/308, which could
otherwise forward the assertion body. `tests/bigquery-token-transport.test.ts`
also verifies signature validity, rejected payload types, body cancellation and
caller refusal. These are not real Google credential or warehouse acceptance.

Token acquisition uses the same bounded OAuth JSON reader as browser login:
256 KiB of actual streamed response bytes and a 15-second deadline for headers
plus body. An excessive declared length is rejected before reading; missing or
understated length cannot bypass byte counting. Invalid UTF-8 is refused even in
unused JSON fields. Timeout aborts and cancels without waiting for cancellation,
and late success cannot continue to a BigQuery call. The deadline begins at the
HTTP exchange, not during local key import/signing. Exact-ceiling success,
oversized responses, late headers and stalled streams have local regression
coverage, including a real stalled stream in Workers with synthetic credentials.

The governed submitter still receives an injected token supplier; this helper is
not implicitly wired into it. Integrators must preserve equivalent protections.
Submission acknowledgments and job observations have their own bounded readers.
Legacy demo query/dry-run responses also have a separate bounded exchange;
bounding each exchange does not bound the entire operation or authorize live
query execution.

## Legacy demo transport boundary

The separate raw dry-run and schema-import query helpers also use manual redirects
and refuse 3xx or already-redirected responses without another request. Rejected
bodies are discarded rather than parsed. Redirects return
`bigquery_redirect_refused`; other HTTP failures return `http_<status>` with a
locally generated message. Upstream status text, error codes, response messages,
query error reasons and network/parser exceptions are not forwarded to callers or
history. This intentionally replaces the older provider-defined error codes.

Successful row conversion, the dry-run flag, production-mode refusals and the
administrator/transaction gates are unchanged. These helpers still do not supply
a governed execution path. A refused provider response cannot trigger catalog persistence.
`tests/bigquery-legacy-miniflare.test.ts` exercises real signing and both helpers
in local Workers with fully intercepted egress; redirects cannot forward its
synthetic Bearer token or SQL. Unit and API regressions also check body cancellation,
private-error suppression, successful results and no persistence after refusal.
No real Google credentials or billable queries are part of these checks.

The legacy query and dry-run responses now share the 256 KiB streamed-byte limit
and a 15-second header-plus-body deadline. Oversized declared lengths are refused
before reading; missing or misleading lengths do not bypass actual byte counting.
Invalid UTF-8 and non-object JSON are refused. Oversized metadata imports fail in
full rather than truncating rows or persisting a partial catalog. Network, size,
encoding and deadline failures retain the static `bigquery_request_failed` or
`bigquery_query_failed` response. Late responses and stalled bodies are cancelled
without waiting for cancellation, and no automatic retry is added.

This deadline starts after token acquisition and does not include signing, SQL
preparation or database work. It may expire before the legacy query API's requested
30-second server wait. Local timeout or cancellation is not evidence that a query
was not accepted, stopped running or incurred no cost. These demo-only helpers
remain unavailable in production and are not a substitute for governed dispatch.
Synthetic unit tests cover exact/over-limit bytes, UTF-8, late headers and shared
deadlines; native Workers tests cover real stalled streams for both helpers. The
schema-import API tests verify that refused responses cannot reach catalog I/O.
