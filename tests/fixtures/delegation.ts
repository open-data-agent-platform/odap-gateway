import { expect } from "vitest";
import worker from "../../worker";
import { SESSION_COOKIE, signAuthPayload } from "../../lib/auth";
import { requestMetricContract } from "../../lib/contract-requests";
import { recordHumanGrant } from "../../lib/contract-human-grants";
import { handoffDelegatedRead } from "../../lib/delegated-handoff";
import { approveSemanticRevision, promoteSemanticRevision, proposeSemanticRevision, recordSemanticValidation } from "../../lib/semantic-candidate-storage";
import { jobDatabase, jobSqlite } from "./job-sqlite";
import metric from "./revenue-metric.json";

export function delegationFixture(file: () => string, enrolled: () => CryptoKeyPair) {
  const db = jobDatabase(file);
  const env = { DB: db, AUTH_COOKIE_SECRET: "synthetic-delegation-test-secret", ODAP_DELEGATION_AUDIENCE: "test-gateway",
    ASSETS: { fetch: async () => { throw new Error("Unexpected asset or external call"); } } };
  const sql = (q: string, params: string[] = []) => jobSqlite(file(), "run", q, params);
  const first = (q: string) => jobSqlite(file(), "readonly-first", q);
  const hex = (data: ArrayBuffer) => Buffer.from(data).toString("hex");
  const keys = () => crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign","verify"]);
  const sign = async (challenge: string, pair = enrolled()) => hex(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" },
    pair.privateKey, new TextEncoder().encode(challenge)));
  const origin = "https://gateway.test";
  async function post(path: string, data: unknown, subject?: string, bindings = env, headers: Record<string,string> = {}) {
    const cookie = subject ? SESSION_COOKIE + "=" + await signAuthPayload({ provider: "google", providerId: subject, name: "Fixture",
      email: "fixture@example.test", expiresAt: Date.now()+60000 }, env.AUTH_COOKIE_SECRET) : "";
    return worker.fetch(new Request(origin+"/api/control/"+path, { method: "POST", body: JSON.stringify(data),
      headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json", "X-Principal-Id": "google:reader", ...headers } }),
      bindings, { waitUntil: () => undefined });
  }
  const input = { operation: "create", grantId: "grant", agentId: "reporter", keyId: "k1" };
  const revoke = (delegationId: string, subject = "reader") => post("t/delegations", { operation: "revoke", delegationId }, subject);
  async function challenge(tenant = "t", grantId = input.grantId) {
    const res = await post(tenant+"/delegations", { ...input, grantId }, "reader");
    expect(res.status).toBe(200);
    return (await res.json() as { delegation: { delegationId: string; challenge: string; expiresAt: string } }).delegation;
  }
  async function setupGrant(tenantId: string) {
    const principalId = "google:reader", owner = { db, tenantId, principalId: "google:owner" };
    await sql("INSERT INTO control_memberships VALUES(?,'google:reader','reader',1),(?,'google:owner','owner',1)", [tenantId,tenantId]);
    const revisionId = "rev", approvalId = "approval", releaseId = "released", evidenceRef = "fixture";
    const { definitionDigest } = await proposeSemanticRevision(owner, { revisionId, ownerId: owner.principalId,
      definitionJson: JSON.stringify({ ...metric, tenantId }), provenanceRef: evidenceRef });
    await recordSemanticValidation(owner, revisionId, definitionDigest, evidenceRef);
    await approveSemanticRevision(owner, { revisionId, approvalId, reviewedDigest: definitionDigest, evidenceRef });
    await sql("INSERT INTO semantic_source_heads VALUES(?,'orders','demo-project','analytics','orders','s1')", [tenantId]);
    await promoteSemanticRevision(owner, { releaseId, approvalId, revisionId });
    const action = { profile: "odap.metric-read.v1", target: "orders", metricId: "revenue", parameters: { year: 2026 } };
    const request = { requestId: "req", releaseId, requestedAgentId: "reporter" };
    expect(await requestMetricContract({ db, tenantId, principalId }, { ...request, action })).toBeTruthy();
    await sql("INSERT INTO dispatch_targets VALUES(?,'orders','released','p1','s1','demo-project','US')", [tenantId]);
    await sql("INSERT INTO dispatch_read_grants VALUES(?,'orders','google:reader','reporter','p1')", [tenantId]);
    expect(await recordHumanGrant(owner, { ...request, grantId: "grant", requesterId: principalId, reviewedAction: action, policyRevision: "p1" })).toBeTruthy();
  }
  async function migrateAndEnroll(tenant = "t") {
    await jobSqlite(file(), "apply-agent-delegations");
    await sql("INSERT INTO agent_verification_keys VALUES(?,'reporter','k1',?,1)", [tenant,hex(await crypto.subtle.exportKey("raw",enrolled().publicKey))]);
  }
  async function seedAdmittedDelegation() {
    await jobSqlite(file(), "setup-v19");
    await setupGrant("t");
    await migrateAndEnroll();
    const d = await challenge();
    const delegationId = d.delegationId;
    expect((await post("t/delegation-proofs", { delegationId, signature: await sign(d.challenge) })).status).toBe(201);
    await jobSqlite(file(), "apply-contract-issuance");
    const issued = await post("t/contract-issuances", { delegationId }, "reader");
    expect(issued.status).toBe(201);
    const contractId = (await issued.json() as { issuance: { contractId: string } }).issuance.contractId;
    await jobSqlite(file(), "apply-delegated-budget");
    await sql(`INSERT INTO bigquery_scan_policies VALUES('t','orders','p1','demo-project','US','on_demand',5000000,
      100000000,strftime('%Y-%m-%dT%H:%M:%fZ','now','+5 minutes'),'fixture')`);
    await sql("INSERT INTO delegated_budget_policies VALUES('t','orders','p1','b',80)");
    const admitted = await post("t/budget-admissions", { contractId }, "reader");
    expect(admitted.status).toBe(201);
    const intentId = (await admitted.json() as { admission: { intentId: string } }).admission.intentId;
    await sql("INSERT INTO control_memberships VALUES('t','google:operator','owner',1)");
    return { delegationId,contractId,intentId };
  }
  async function seedAmbiguousDelegation(beforeClaim: () => Promise<void>) {
    const ids = await seedAdmittedDelegation();
    await jobSqlite(file(),"apply-delegated-jobs");
    expect((await post("t/job-preparations",{ intentId:ids.intentId },"operator")).status).toBe(201);
    await jobSqlite(file(),"apply-delegated-handoff");
    await beforeClaim();
    let tag = "", cap = "";
    const h = await handoffDelegatedRead({ db,tenantId:"t",principalId:"google:operator" },ids.intentId,
      { audience:env.ODAP_DELEGATION_AUDIENCE,principalId:"google:reader",agentId:"reporter" },
      { target:"orders",metricId:"revenue",parameters:{ year:2026 } },async body => {
        const job = JSON.parse(body);
        tag = job.configuration.labels.odap_action; cap = job.configuration.query.maximumBytesBilled;
        throw new Error("fixture: submission acknowledgement lost");
      });
    expect(h.state).toBe("observation-required");
    return { ...ids, ref:h.jobReference,receiptId:h.receiptId,tag,cap };
  }
  return { db, env, sql, first, hex, keys, sign, origin, post, input, revoke, challenge, setupGrant, migrateAndEnroll, seedAdmittedDelegation, seedAmbiguousDelegation };
}
