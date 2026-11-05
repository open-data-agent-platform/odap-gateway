# P0 Control Baseline

Reviewed 2026-11-05. Implementation evidence, not a new conformance assessment.

| Surface | Observed implementation | Gap before production control-plane claims |
|---|---|---|
| Generation | lib/copilot-engine.ts uses question-pattern rules; live-sql-workbench invokes it in the client | Permission-filtered server-side context and release-bound generation |
| Query preview | functions/api/query/dry-run.ts accepts requests without a session; lib/bigquery.ts can return simulated estimates when credentials are missing | Explicit production mode, authentication and fail-closed behavior |
| Warehouse access | lib/bigquery.ts wraps dry-run and query calls; maximumBytesBilled is configurable | Prove all external execution paths bind validated contracts, permissions and budget |
| Semantic lifecycle | lib/semantic-registry.mjs and CLI implement a trusted local lifecycle | Tenant-scoped durable authenticated service; no operator-provided identity in production |
| Approval and audit | Existing admin review and D1 records | Execution-bound contracts and complete correlated receipts, including denial and recovery |
| Three control objects | lib/control-objects.ts defines draft v0.1 types, eligibility checks, receipt shape check and canonical JSON profile | Runtime wire-schema parsing, durable state, atomic consumption, hashing/signing and API integration |

## Trust boundary

The new evaluator is a pure precondition check, not an authorization service.
Its typed inputs must come from authenticated server-side loaders. It does not
parse arbitrary JSON, verify issuer signatures, prove metric-to-SQL correctness,
consume contracts, reserve budgets, or execute queries. Passing it alone grants
no execution permission. Receipt validation checks shape, not proof authenticity.

Canonical JSON sorts keys and accepts JSON primitives with safe-integer numbers;
decimal quantities use strings. This local draft is not RFC 8785 or a published
ODAP Protocol. Define Unicode/encoding, digest, issuer trust and signature rules
before interoperable signing. Existing CLI hashes use a separate profile; a
migration is required before combining them with these objects.

## P0 acceptance still open

Development update: strict runtime guards now validate the three wire objects
and execution context. Unknown fields/versions and noncanonical UTC timestamps
are rejected. Use evaluateUntrustedExecution at untrusted JSON boundaries.

The dry-run endpoint now supports explicit GATEWAY_MODE=production. This requires
a session, live credentials and D1 binding, rejects policy-blocked or simulated
previews, and refuses successful responses when persistence fails. Omitted mode
retains legacy demo-compatible behavior; configure production explicitly.
This is not complete tenant authorization or the full execution contract path.

- Runtime schemas and complete lifecycle fixtures for all three objects.
- Full execution/auth path inventory and explicit production/demo configuration.
- Independent review of contracts, canonicalization and recovery semantics.
- Five target-team interviews and two pilot commitments; none claimed here.
- Tenant-scoped storage and permission design before a production API.

This commit starts P0. It does not complete P0 or any progression gate, alter
existing endpoint behavior, or upgrade the Five Musts clause mapping.
