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
  carries a timeout signal; an integrated sender must honor it.
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
