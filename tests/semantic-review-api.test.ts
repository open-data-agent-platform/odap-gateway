import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import worker from "../worker";
import { proposeMetricRequest } from "../lib/review-contract-request";
import { checkOwnerReview } from "../lib/owner-grant-review";
import { grantMatchedRequest } from "../lib/owner-grant-decision";
import { readOwnProposal } from "../lib/contract-requests";
import { inspectOwnProposal } from "../lib/request-inspection";
import { signAuthPayload, SESSION_COOKIE } from "../lib/auth";
import { authorizeControlRequest } from "../lib/control-storage";
import { readReviewDefinition, readSemanticReview } from "../lib/semantic-review";
import { inspectRevision, submitApproval, submitPromotion, submitRetirement, submitValidation, submitWithdrawal } from "../lib/review-inspection";
import { approveSemanticRevision, proposeSemanticRevision, recordSemanticValidation,
  promoteSemanticRevision, withdrawSemanticApproval } from "../lib/semantic-candidate-storage";
import { jobDatabase, jobSqlite } from "./fixtures/job-sqlite";
import metric from "./fixtures/revenue-metric.json";

let dir: string, file: string;
const db = jobDatabase(() => file);
const secret = "synthetic-local-review-test-secret";
const env = { DB: db, AUTH_COOKIE_SECRET: secret, ASSETS: { fetch: async () => { throw new Error("Unexpected asset lookup"); } } };
const sql = (query: string, params: string[] = []) => jobSqlite(file, "run", query, params);
const owner = (tenantId = "t") => ({ db, tenantId, principalId: "google:owner" });
const decision = { approvalId: "decision", revisionId: "rev", releaseId: "published" };
async function cookie(subject: string) {
  const token = await signAuthPayload({ provider: "google", providerId: subject, email: "fixture@example.test",
    name: "Fixture", expiresAt: Date.now() + 60_000 }, secret);
  return SESSION_COOKIE + "=" + token;
}
function request(path: string, session = "", method = "GET") {
  return new Request("https://gateway.test/api/control/" + path, { method,
    headers: { Cookie: session, "X-Principal-Id": "google:owner", "X-Tenant-Id": "t" } });
}
const fetchLocal = (req: Request) => worker.fetch(req, env, { waitUntil: () => undefined });
async function sessionFetch(subject: string): Promise<typeof fetch> {
  const session = await cookie(subject);
  return (path, init) => {
    const headers = new Headers(init?.headers);
    headers.set("Cookie", session);
    headers.set("Origin", "https://gateway.test");
    return fetchLocal(new Request(new URL(String(path), "https://gateway.test"), { ...init, headers }));
  };
}
async function postCommand(path: string, body: BodyInit, subject: string, overrides: Record<string, string> = {}) {
  const origin = "https://gateway.test";
  const init = { method: "POST", body, duplex: "half", headers: { Origin: origin, "Content-Type": "application/json",
    Cookie: await cookie(subject), "X-Principal-Id": "google:owner", ...overrides } };
  return fetchLocal(new Request(origin + "/api/control/" + path, init));
}
async function review(tenant = "t", subject = "reviewer") {
  const res = await fetchLocal(request(tenant + "/review/rev", await cookie(subject)));
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  return (await res.json() as { review: Awaited<ReturnType<typeof readSemanticReview>> }).review;
}
const retire = (reason: string, subject = "owner", releaseId = "published", tenant = "t") =>
  postCommand(tenant + "/retirements", JSON.stringify({ releaseId, reason }), subject);
const propose = (tenant = "t") => proposeSemanticRevision(owner(tenant), { revisionId: "rev", ownerId: "google:owner",
  provenanceRef: "fixture:private-provenance", definitionJson: JSON.stringify({ ...metric, tenantId: tenant }) });
async function approve(tenant: string, digest: string) {
  await approveSemanticRevision(owner(tenant), { approvalId: "decision", revisionId: "rev", reviewedDigest: digest, evidenceRef: "fixture:private-evidence" });
}
async function publish(tenant: string) {
  await sql("INSERT INTO semantic_source_heads VALUES(?,'orders','demo-project','analytics','orders','s1')", [tenant]);
  await promoteSemanticRevision(owner(tenant), decision);
}
async function members(tenant: string) {
  await sql("INSERT INTO control_memberships VALUES(?,'google:owner','owner',1),(?,'google:reviewer','reviewer',1),(?,'google:reader','reader',1)",
    [tenant, tenant, tenant]);
}

describe("authenticated effective review snapshot", { timeout: 25000 }, () => {
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "odap-review-"));
    file = join(dir, "review.db");
    await jobSqlite(file, "setup");
    await members("t");
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("follows the actual lifecycle and preserves the historical release response across retirement", async () => {
    const { definitionDigest } = await propose();
    const candidate = await review();
    expect(candidate).toEqual({ tenantId: "t", revisionId: "rev", metricId: "revenue", sourceRevision: "s1", definitionDigest,
      state: "candidate", canRecordValidation: false, canReviewApproval: false, canRequestPromotion: false, canWithdrawApproval: false, approvalId: null, releaseId: null, validatedAt: null, approvedAt: null, publishedAt: null,
      canRetireRelease: false, withdrawnAt: null, retiredAt: null });
    await recordSemanticValidation(owner(), "rev", definitionDigest, "fixture:private-evidence");
    expect(await review()).toMatchObject({ state: "validated", validatedAt: expect.any(String), approvedAt: null });
    await approve("t", definitionDigest);
    expect(await review()).toMatchObject({ state: "approved", approvalId: "decision", approvedAt: expect.any(String), releaseId: null });
    await publish("t");
    const published = await review();
    expect(published).toMatchObject({ state: "published", releaseId: "published", publishedAt: expect.any(String) });
    const historical = request("t/release/published", await cookie("reader"));
    const original = await (await fetchLocal(historical)).text();
    expect(JSON.parse(original).object.state).toBe("released");
    const reasons = ["fixture:superseded", "fixture:source-removed"];
    const replies = await Promise.all(reasons.map(reason => retire(reason)));
    expect(replies.map(r => r.status).sort()).toEqual([200, 201]);
    const winner = replies.findIndex(r => r.status === 201);
    const retired = await review();
    expect(retired).toEqual({ ...published, state: "retired", retiredAt: expect.any(String) });
    for (const [i, res] of replies.entries()) {
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toEqual({ ok: true, effect: "future_dispatch_claims_only",
        retirement: { status: i === winner ? "retired" : "already_retired", retiredAt: retired?.retiredAt } });
    }
    expect(await jobSqlite(file, "readonly-first", `SELECT reason, retired_by,
      (SELECT count(*) FROM control_object_events WHERE object_kind='semantic_release_retirement') AS audits,
      (SELECT count(*) FROM semantic_approval_withdrawals) AS withdrawals FROM dispatch_retired_releases`))
      .toEqual({ reason: reasons[winner], retired_by: "google:owner", audits: 1, withdrawals: 0 });
    expect(await (await fetchLocal(historical)).text()).toBe(original);
  });

  it("isolates identical revision and decision IDs in two tenants, including withdrawn versus published", async () => {
    await sql("INSERT INTO control_tenants VALUES('peer','Peer')");
    await members("peer");
    for (const tenant of ["t", "peer"]) {
      const { definitionDigest } = await propose(tenant);
      await recordSemanticValidation(owner(tenant), "rev", definitionDigest, "fixture:private-evidence");
      await approve(tenant, definitionDigest);
    }
    await withdrawSemanticApproval(owner(), { ...decision, reason: "fixture:private-withdrawal" });
    await publish("peer");
    expect(await review()).toMatchObject({ state: "withdrawn", withdrawnAt: expect.any(String), releaseId: null });
    expect(await review("peer", "owner")).toMatchObject({ tenantId: "peer", state: "published", withdrawnAt: null, releaseId: "published" });
  });

  it("rejects forged identity, hides drafts from readers, and rechecks membership after authorization", async () => {
    await propose();
    expect((await fetchLocal(request("t/review/rev"))).status).toBe(401);
    expect((await fetchLocal(request("t/review/rev", await cookie("outsider")))).status).toBe(403);
    const reader = await cookie("reader");
    const hidden = await fetchLocal(request("t/review/rev", reader));
    const absent = await fetchLocal(request("t/review/missing", reader));
    expect([hidden.status, absent.status]).toEqual([404, 404]);
    expect(await hidden.text()).toBe(await absent.text());
    const signed = request("t/review/rev", await cookie("reviewer"));
    const auth = await authorizeControlRequest(signed, env, "t");
    if (!auth.ok) throw new Error("Expected an initially authorized context");
    await sql("UPDATE control_memberships SET role='reader' WHERE principal_id='google:reviewer' AND tenant_id='t'");
    expect(await readSemanticReview(auth.access, "rev")).toBeNull();
    expect((await fetchLocal(signed)).status).toBe(404);
    expect((await fetchLocal(request("t/review/rev", await cookie("owner"), "POST"))).status).toBe(405);
  });

  it("fails closed on missing schema and never fabricates a legacy retirement timestamp", async () => {
    file = join(dir, "v16.db");
    await jobSqlite(file, "setup-v16");
    await members("t");
    const { definitionDigest } = await propose();
    await recordSemanticValidation(owner(), "rev", definitionDigest, "fixture:private-evidence");
    await approve("t", definitionDigest);
    await publish("t");
    await sql("INSERT INTO dispatch_retired_releases VALUES('t','published','historic')");
    const unavailable = await fetchLocal(request("t/review/rev", await cookie("owner")));
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({ ok: false, code: "control_storage_unavailable" });
    await jobSqlite(file, "apply-semantic-retirement");
    const legacy = await inspectRevision("t", "rev", new AbortController().signal, await sessionFetch("owner"));
    expect(legacy).toMatchObject({ ok: true, value: { state: "retired", retiredAt: null, canRetireRelease: false } });
    const replay = await retire("replacement");
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ ok: true, effect: "future_dispatch_claims_only", retirement: { status: "legacy_retired" } });
    expect(await jobSqlite(file, "readonly-first", "SELECT reason,retired_at,retired_by FROM dispatch_retired_releases"))
      .toEqual({ reason: "historic", retired_at: null, retired_by: null });
    expect(await review()).toMatchObject({ state: "retired", releaseId: "published", publishedAt: expect.any(String), retiredAt: null });
  });

  describe("authenticated contract request intake", () => {
    const action = { profile: "odap.metric-read.v1", metricId: "revenue", target: "orders", parameters: { year: 2026 } };
    const input = { requestId: "req", requestedAgentId: "reporter", releaseId: "published", action };
    const submit = (data: unknown = input, tenant = "t", subject = "reader", headers = {}) =>
      postCommand(tenant + "/contract-requests", JSON.stringify(data), subject, headers);
    const counts = () => jobSqlite(file, "readonly-first", `SELECT
      (SELECT count(*) FROM approval_contracts) AS contracts,(SELECT count(*) FROM execution_intents) AS intents,
      (SELECT count(*) FROM dispatch_claims) AS dispatches,(SELECT sum(reserved_units) FROM control_budgets) AS reserved`);
    async function publishViaApi(definition = metric) {
      const cmd = (kind: string, data: unknown, subject = "owner") => postCommand("t/" + kind, JSON.stringify(data), subject);
      const proposal = await cmd("proposals", { revisionId: "rev", ownerId: "google:owner", provenanceRef: "fixture",
        definition }, "reviewer");
      expect(proposal.status).toBe(201);
      const { proposal: { definitionDigest } } = await proposal.json() as { proposal: { definitionDigest: string } };
      const basis = { revisionId: "rev", reviewedDigest: definitionDigest, evidenceRef: "fixture" };
      expect((await cmd("validations", basis)).status).toBe(201);
      expect((await cmd("approvals", { ...basis, approvalId: "decision" })).status).toBe(201);
      await sql("INSERT INTO semantic_source_heads VALUES('t','orders','demo-project','analytics','orders','s1')");
      expect((await cmd("promotions", decision)).status).toBe(201);
    }
    describe("requester history lookup", () => {
      const readEnv = { ...env, DB: jobDatabase(() => file, "readonly") };
      async function get(tenant: string, subject: string, id = "req", method = "GET") {
        return worker.fetch(request(tenant + "/contract-request/" + id, subject ? await cookie(subject) : "", method),
          readEnv, { waitUntil: () => undefined });
      }
      it("isolates identical IDs across tenants and requesters, including owners, on a read-only connection", async () => {
        await publishViaApi();
        await sql("INSERT INTO control_tenants VALUES('peer','Peer')");
        await members("peer");
        const { definitionDigest } = await propose("peer");
        await recordSemanticValidation(owner("peer"), "rev", definitionDigest, "fixture:private-evidence");
        await approve("peer", definitionDigest);
        await publish("peer");
        for (const [tenant, who] of [["t", "reader"], ["t", "reviewer"], ["peer", "reader"]]) {
          expect((await submit({ ...input, requestedAgentId: tenant + "-" + who }, tenant, who)).status).toBe(201);
        }
        const past = { grantedAt: "2020-01-01T00:00:00.000Z", expiresAt: "2020-01-01T00:10:00.000Z" };
        await sql(`INSERT INTO contract_requests SELECT tenant_id,principal_id,'historical',release_id,requested_agent_id,
          action_digest,'2020-01-01T00:00:00.000Z' FROM contract_requests WHERE id='req'`);
        for (const who of ["reader", "reviewer"]) {
          await sql("INSERT INTO contract_human_grants VALUES('t',?,?,'historical','google:owner','old-policy','demo-project','US',?,?)",
            [who + "-grant", "google:" + who, past.grantedAt, past.expiresAt]);
        }
        for (const [tenant, who] of [["peer", "reader"], ["t", "reviewer"], ["t", "reader"]]) {
          const res = await get(tenant, who);
          expect(res.headers.get("Cache-Control")).toBe("no-store");
          expect(res.status).toBe(200);
          const baseline = await res.json();
          expect(baseline).toEqual({ ok: true, object: { tenantId: tenant, id: "req", releaseId: "published",
            recordedState: "proposed", requestedAgentId: tenant + "-" + who, actionDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
            requestedAt: expect.any(String) } });
          const history = await get(tenant, who, "historical?view=grant-history");
          expect(history.status).toBe(200);
          expect(history.headers.get("Cache-Control")).toBe("no-store");
          expect(await history.json()).toEqual({ ok: true, object: { ...baseline.object, id: "historical", requestedAt: past.grantedAt,
            grantReference: tenant === "peer" ? null : { grantId: who + "-grant", ...past } } });
        }
        for (const res of [await get("t", "owner"), await get("t", "reader", "absent"), await get("peer", "reviewer"),
          await get("t", "owner", "historical?view=grant-history"), await get("peer", "reviewer", "historical?view=grant-history")]) {
          expect(res.status).toBe(404);
          expect(await res.json()).toEqual({ ok: false, code: "not_found" });
        }
        expect((await get("t", "")).status).toBe(401);
        expect((await get("t", "reader", "req", "POST")).status).toBe(405);
        expect((await get("t", "reader", "req?view=grant-history&view=grant-history")).status).toBe(400);
        expect((await get("t", "reader", "req?view=private")).status).toBe(400);
      });
      it("survives retirement but rechecks membership even after authentication", async () => {
        await publishViaApi();
        expect((await submit()).status).toBe(201);
        const original = await (await get("t", "reader")).json();
        expect((await retire("fixture: retired")).status).toBe(201);
        expect(await (await get("t", "reader")).json()).toEqual(original);
        const snapshot = await inspectOwnProposal("t", "req", new AbortController().signal, () => get("t", "reader"));
        expect(snapshot).toEqual({ state: "ready", snapshot: original.object });
        const auth = await authorizeControlRequest(request("t/contract-request/req", await cookie("reader")), readEnv, "t");
        if (!auth.ok) throw new Error("fixture: expected active member");
        await sql("UPDATE control_memberships SET active=0 WHERE tenant_id='t' AND principal_id='google:reader'");
        expect(await readOwnProposal(auth.access, "req")).toBeNull();
        expect(await readOwnProposal(auth.access, "req", true)).toBeNull();
        expect((await get("t", "reader")).status).toBe(403);
      });
      it("retains the base proposal lookup before migration 0019 without claiming no grant exists", async () => {
        file = join(dir, "legacy.db");
        await jobSqlite(file, "setup-v18");
        await members("t");
        await publishViaApi();
        expect((await submit()).status).toBe(201);
        expect((await get("t", "reader")).status).toBe(200);
        const result = await get("t", "reader", "req?view=grant-history");
        expect(result.status).toBe(503);
        expect(await result.json()).toEqual({ ok: false, code: "control_storage_unavailable" });
      });
    });
    it("resolves a lost intake acknowledgement for the original proposal without issuing authority", async () => {
      await publishViaApi();
      const before = await counts();
      const send = await sessionFetch("reader");
      const signal = new AbortController().signal;
      let firstStatus = 0;
      const lost: typeof fetch = async (url, init) => {
        firstStatus = (await send(url, init)).status;
        throw new Error("fixture: acknowledgement lost after insert");
      };
      expect(await proposeMetricRequest("t", input, signal, lost)).toBe("unknown");
      expect(firstStatus).toBe(201);
      expect(await proposeMetricRequest("t", input, signal, send)).toBe("proposed");
      expect(await proposeMetricRequest("t", { ...input, requestedAgentId: "another" }, signal, send)).toBe("refused");
      expect((await retire("fixture: no further requests")).status).toBe(201);
      expect(await proposeMetricRequest("t", input, signal, send)).toBe("refused");
      expect(await jobSqlite(file, "readonly-first", "SELECT count(*) AS n FROM contract_requests")).toEqual({ n: 1 });
      expect(await counts()).toEqual(before);
    });
    describe("human grant for a stored request", () => {
      const command = { grantId: "g1", requestId: "req", requesterId: "google:reader", releaseId: "published",
        requestedAgentId: "reporter", policyRevision: "p1", reviewedAction: action };
      const grant = (body: unknown = command, subject = "owner", tenant = "t", headers = {}) =>
        postCommand(tenant + "/human-grants", JSON.stringify(body), subject, headers);
      const n = () => jobSqlite(file, "readonly-first", "SELECT count(*) AS n FROM contract_human_grants");
      async function prepareRequest() {
        await publishViaApi();
        expect((await submit()).status).toBe(201);
      }
      async function allowRead() {
        await sql("INSERT INTO dispatch_targets VALUES('t','orders','published','p1','s1','demo-project','US')");
        await sql("INSERT INTO dispatch_read_grants VALUES('t','orders','google:reader','reporter','p1')");
      }
      describe("named owner's read-only grant review", () => {
        const { grantId, ...terms } = command;
        const check = async (data: unknown = terms, subject = "owner", tenant = "t", headers = {}) => {
          const session = subject ? await cookie(subject) : "";
          return worker.fetch(new Request("https://gateway.test/api/control/" + tenant + "/human-grant-reviews", {
            method: "POST", headers: { Origin: "https://gateway.test", "Content-Type": "application/json",
              Cookie: session, "X-Principal-Id": "google:owner", ...headers }, body: JSON.stringify(data)
          }), { ...env, DB: jobDatabase(() => file, "readonly") }, { waitUntil: () => undefined });
        };
        it("matches the full action only for the named owner; neither writes nor widens requester history", async () => {
          await prepareRequest();
          await allowRead();
          await sql("INSERT INTO control_memberships VALUES('t','google:other','owner',1)");
          await sql("INSERT INTO control_tenants VALUES('peer','Peer')");
          await members("peer");
          const altAction = { ...action, parameters: { year: 2025 } };
          expect((await submit({ ...input, action: altAction }, "t", "reviewer")).status).toBe(201);
          await sql("INSERT INTO dispatch_read_grants VALUES('t','orders','google:reviewer','reporter','p1')");
          const before = await counts();
          const good = await check({ ...terms, reviewedAction: { parameters: action.parameters, target: action.target,
            metricId: action.metricId, profile: action.profile } });
          expect(good.status).toBe(200);
          expect(good.headers.get("Cache-Control")).toBe("no-store");
          expect(await good.json()).toEqual({ ok: true, review: { state: "matched", tenantId: "t", reviewedBy: "google:owner", requesterId: terms.requesterId,
            requestId: terms.requestId, releaseId: terms.releaseId, requestedAgentId: terms.requestedAgentId,
            policyRevision: terms.policyRevision, actionDigest: "sha256:" + createHash("sha256")
              .update('{"metricId":"revenue","parameters":{"year":2026},"profile":"odap.metric-read.v1","target":"orders"}').digest("hex") } });
          for (const res of [await check(terms, "other"), await check(terms, "owner", "peer"),
            await check({ ...terms, reviewedAction: altAction }), await check({ ...terms, requesterId: "google:reviewer" }),
            await check({ ...terms, requestedAgentId: "another" }), await check({ ...terms, requestId: "unknown" })]) {
            expect(res.status).toBe(404);
            expect(await res.json()).toEqual({ ok: false, code: "grant_review_unavailable" });
          }
          expect((await check({ ...terms, requesterId: "google:reviewer", reviewedAction: altAction })).status).toBe(200);
          expect((await fetchLocal(request("t/contract-request/req", await cookie("owner")))).status).toBe(404);
          expect(await n()).toEqual({ n: 0 });
          expect(await counts()).toEqual(before);
        });
        it("does not turn a prior match into authority after policy drift or release retirement", async () => {
          await prepareRequest();
          await allowRead();
          const asOwner = await sessionFetch("owner");
          const ids = { requesterId: terms.requesterId, requestId: terms.requestId, requestedAgentId: terms.requestedAgentId,
            policyRevision: terms.policyRevision };
          const inspect = () => checkOwnerReview("t", terms.releaseId, ids, action, new AbortController().signal, asOwner);
          const initial = await inspect();
          if (initial.state !== "matched") throw new Error("Expected the named owner's match");
          await sql("UPDATE dispatch_targets SET policy_revision='p2' WHERE tenant_id='t'");
          expect(await inspect()).toEqual({ state: "noMatch" });
          expect(await grantMatchedRequest(initial.match, new AbortController().signal, asOwner)).toEqual({ state: "refused" });
          expect((await grant()).status).toBe(409);
          await sql("UPDATE dispatch_read_grants SET policy_revision='p2' WHERE tenant_id='t'");
          expect((await check({ ...terms, policyRevision: "p2" })).status).toBe(200);
          expect((await retire("fixture: retired since review")).status).toBe(201);
          expect((await check({ ...terms, policyRevision: "p2" })).status).toBe(404);
          expect((await grant({ ...command, policyRevision: "p2" })).status).toBe(409);
          expect(await n()).toEqual({ n: 0 });
        });
        it("recovers a committed owner grant after losing its acknowledgement without issuing or executing", async () => {
          await prepareRequest();
          await allowRead();
          const before = await counts(), asOwner = await sessionFetch("owner"), signal = new AbortController().signal;
          const { requesterId, requestId, requestedAgentId, policyRevision } = terms;
          const inspect = () => checkOwnerReview("t", terms.releaseId, { requesterId, requestId, requestedAgentId, policyRevision }, action, signal, asOwner);
          const first = await inspect();
          if (first.state !== "matched") throw new Error("Expected an owner match");
          let storedStatus = 0;
          expect(await grantMatchedRequest(first.match, signal, async (...args) => {
            storedStatus = (await asOwner(...args)).status;
            throw new Error("fixture: acknowledgement lost");
          })).toEqual({ state: "unknown" });
          expect(storedStatus).toBe(201);
          const second = await inspect();
          if (second.state !== "matched") throw new Error("Expected an owner match after reopening");
          let replayStatus = 0;
          const replay = await grantMatchedRequest(second.match, signal, async (...args) => {
            const response = await asOwner(...args);
            replayStatus = response.status;
            return response;
          });
          expect(replay).toMatchObject({ state: "recorded", grantId: expect.stringMatching(/^g-[a-f0-9]{64}$/) });
          expect(replayStatus).toBe(200);
          if (replay.state !== "recorded") throw new Error("Expected recorded grant");
          expect((await retire("fixture: retired after the owner acknowledgement")).status).toBe(201);
          const reader = await sessionFetch("reader");
          const found = await inspectOwnProposal("t", terms.requestId, signal, reader);
          expect(found).toMatchObject({ state: "ready", snapshot: { recordedState: "proposed",
            grantReference: { grantId: replay.grantId, expiresAt: replay.expiresAt } } });
          expect(await n()).toEqual({ n: 1 });
          expect(await counts()).toEqual(before);
        });
        it("rejects unsigned, nonowner, cross-origin, oversized and digest-only requests", async () => {
          expect((await check(terms, "")).status).toBe(401);
          expect((await check(terms, "reader")).status).toBe(403);
          expect((await check(terms, "owner", "t", { Origin: "https://other.test" })).status).toBe(403);
          for (const extra of [{ grantId }, { grantedBy: "google:owner" }, { reviewedAction: "sha256:claimed" },
            { actionDigest: "claimed" }]) expect((await check({ ...terms, ...extra })).status).toBe(400);
          expect((await check({ ...terms, reviewedAction: "x".repeat(16385) }, "owner", "t", { "Content-Length": "1" })).status).toBe(413);
        });
      });
      it("records one expiring owner decision on concurrent identical reviews without issuing a contract", async () => {
        await prepareRequest();
        await allowRead();
        const before = await counts();
        const responses = await Promise.all([grant(), grant()]);
        expect(responses.map(r => r.status).sort()).toEqual([200, 201]);
        const [a,b] = await Promise.all(responses.map(r => r.json() as Promise<{ grant: Record<string, string> }>));
        expect(a).toEqual(b);
        expect(a.grant).toEqual({ tenantId: "t", grantId: "g1", requestId: "req", requesterId: "google:reader", requestedAgentId: "reporter",
          releaseId: "published", policyRevision: "p1", grantedBy: "google:owner", grantedAt: expect.any(String),
          expiresAt: expect.any(String), actionDigest: "sha256:" + createHash("sha256")
            .update('{"metricId":"revenue","parameters":{"year":2026},"profile":"odap.metric-read.v1","target":"orders"}').digest("hex") });
        expect(Date.parse(a.grant.expiresAt) - Date.parse(a.grant.grantedAt)).toBe(600000);
        expect((await grant({ ...command, grantId: "competing" })).status).toBe(409);
        expect(await n()).toEqual({ n: 1 });
        await sql("UPDATE dispatch_targets SET location='EU' WHERE tenant_id='t'");
        expect((await grant()).status).toBe(409);
        expect(await counts()).toEqual(before);
      });
      it("requires exact action, requester, delegate, tenant, release, current read policy and named owner", async () => {
        await prepareRequest();
        expect((await grant()).status).toBe(409);
        await allowRead();
        await sql("INSERT INTO control_memberships VALUES('t','google:other','owner',1)");
        await sql("INSERT INTO control_tenants VALUES('peer','Peer')");
        await members("peer");
        for (const fields of [{ reviewedAction: { ...action, parameters: { year: 2025 } } }, { requestId: "other" },
          { requestedAgentId: "other" }, { releaseId: "r" }, { requesterId: "google:reviewer" }, { policyRevision: "p2" }])
          expect((await grant({ ...command, ...fields })).status).toBe(409);
        expect((await grant(command, "other")).status).toBe(409);
        expect((await grant(command, "owner", "peer")).status).toBe(409);
        expect((await grant(command, "reader")).status).toBe(403);
        expect((await grant(command, "owner", "t", { Cookie: "" })).status).toBe(401);
        expect((await grant(command, "owner", "t", { Origin: "https://other.test" })).status).toBe(403);
        for (const fields of [{ grantedBy: "google:owner" }, { actionDigest: "claimed" }, { expiresAt: "2099" }, { reviewedAction: "digest" }])
          expect((await grant({ ...command, ...fields })).status).toBe(400);
        expect((await submit(input, "t", "owner")).status).toBe(201);
        await sql("INSERT INTO dispatch_read_grants VALUES('t','orders','google:owner','reporter','p1')");
        expect((await grant({ ...command, requesterId: "google:owner" })).status).toBe(409);
        expect(await n()).toEqual({ n: 0 });
      });
      it("binds equal request IDs to their respective principals and actions", async () => {
        await prepareRequest();
        await allowRead();
        const otherAction = { ...action, parameters: { year: 2025 } };
        await sql("INSERT INTO dispatch_read_grants VALUES('t','orders','google:reviewer','reporter','p1')");
        expect((await submit({ ...input, action: otherAction }, "t", "reviewer")).status).toBe(201);
        const other = { ...command, requesterId: "google:reviewer", reviewedAction: otherAction };
        expect((await grant({ ...other, reviewedAction: action })).status).toBe(409);
        expect((await grant(command)).status).toBe(201);
        expect((await grant(other)).status).toBe(409); // this grant ID belongs to the reader's request
        expect((await grant({ ...other, grantId: "g2" })).status).toBe(201);
        expect(await n()).toEqual({ n: 2 });
      });
      it("accepts an action at the intake size limit and bounds the larger review body by actual bytes", async () => {
        await publishViaApi({ ...metric, filters: { year: { ...metric.filters.year, type: "STRING" } } });
        await allowRead();
        const large = { ...action, parameters: { year: "" } };
        large.parameters.year = "x".repeat(8192 - JSON.stringify({ ...input, action: large }).length);
        expect((await submit({ ...input, action: large })).status).toBe(201);
        expect(JSON.stringify({ ...command, reviewedAction: large }).length).toBeGreaterThan(8192);
        expect((await grant({ ...command, reviewedAction: large })).status).toBe(201);
        expect((await grant({ ...command, reviewedAction: "x".repeat(16385) }, "owner", "t", { "Content-Length": "1" })).status).toBe(413);
      });
      it.each(["owner demoted", "requester inactive", "read grant removed", "release retired", "catalog changed", "policy changed"])(
        "rejects a grant after authentication if %s before the write", async change => {
          await prepareRequest();
          await allowRead();
          const body = new ReadableStream({ async pull(ctrl) {
            if (change === "release retired") expect((await retire("changed")).status).toBe(201);
            else if (change === "owner demoted") await sql("UPDATE control_memberships SET role='reviewer' WHERE tenant_id='t' AND principal_id='google:owner'");
            else if (change === "requester inactive") await sql("UPDATE control_memberships SET active=0 WHERE tenant_id='t' AND principal_id='google:reader'");
            else if (change === "read grant removed") await sql("DELETE FROM dispatch_read_grants WHERE tenant_id='t'");
            else if (change === "policy changed") await sql("UPDATE dispatch_targets SET policy_revision='p2' WHERE tenant_id='t'");
            else await sql("UPDATE semantic_source_heads SET dataset_id='changed' WHERE tenant_id='t'");
            ctrl.enqueue(new TextEncoder().encode(JSON.stringify(command)));
            ctrl.close();
          } }, { highWaterMark: 0 });
          const res = await postCommand("t/human-grants", body, "owner");
          expect(res.status).toBe(409);
          expect(await res.json()).toEqual({ ok: false, code: "human_grant_not_recorded" });
          expect(await n()).toEqual({ n: 0 });
        });
      it("does not backfill decisions, rewrite history or renew an expired grant", async () => {
        file = join(dir, "v18.db");
        await jobSqlite(file, "setup-v18");
        await members("t");
        await prepareRequest();
        await allowRead();
        expect((await grant()).status).toBe(503);
        await jobSqlite(file, "apply-human-grants");
        expect(await n()).toEqual({ n: 0 });
        await sql(`INSERT INTO contract_human_grants VALUES('t','g1','google:reader','req','google:owner','p1',
          'demo-project','US','2000-01-01T00:00:00.000Z','2000-01-01T00:10:00.000Z')`);
        expect((await grant()).status).toBe(409);
        expect((await grant({ ...command, grantId: "renewed" })).status).toBe(409);
        await expect(sql("UPDATE contract_human_grants SET location='changed'")).rejects.toThrow();
        await expect(sql("DELETE FROM contract_human_grants")).rejects.toThrow();
        await sql(`INSERT OR REPLACE INTO contract_human_grants SELECT tenant_id,'replace',requester_id,request_id,
          granted_by,policy_revision,project_id,location,granted_at,expires_at FROM contract_human_grants`);
        expect(await jobSqlite(file, "readonly-first", "SELECT id,expires_at FROM contract_human_grants"))
          .toEqual({ id: "g1", expires_at: "2000-01-01T00:10:00.000Z" });
      });
    });
    it("admits a proposed action once, distinguishes changed retries and never grants execution", async () => {
      await publishViaApi();
      const before = await counts();
      const replies = await Promise.all([submit(), submit()]);
      expect(replies.map(r => r.status).sort()).toEqual([200, 201]);
      const [first, replay] = await Promise.all(replies.map(r => r.json()));
      expect(first).toEqual(replay);
      expect(first).toEqual({ ok: true, request: { requestId: "req", releaseId: "published", requestedAgentId: "reporter",
        requestedAt: expect.any(String), state: "proposed", actionDigest: "sha256:" + createHash("sha256")
          .update('{"metricId":"revenue","parameters":{"year":2026},"profile":"odap.metric-read.v1","target":"orders"}').digest("hex") } });
      expect((await submit({ ...input, action: { ...action, parameters: { year: 2025 } } })).status).toBe(409);
      expect((await submit({ ...input, requestedAgentId: "new-agent" })).status).toBe(409);
      expect(await jobSqlite(file, "readonly-first", "SELECT principal_id AS principal,count(*) AS n FROM contract_requests"))
        .toEqual({ principal: "google:reader", n: 1 });
      expect((await retire("source retired")).status).toBe(201);
      for (const id of ["req", "after"]) expect((await submit({ ...input, requestId: id })).status).toBe(409);
      expect(await counts()).toEqual(before);
    });
    it("refuses cross-tenant releases, raw SQL, forged authority, bad parameters, stale catalogs and oversized bodies", async () => {
      await publishViaApi();
      await sql("INSERT INTO control_tenants VALUES('peer','Peer')");
      await members("peer");
      expect((await submit(input, "peer")).status).toBe(409);
      expect((await submit({ ...input, releaseId: "r" })).status).toBe(409); // legacy release, no promotion
      for (const extra of [{ principalId: "google:owner" }, { authority: "human" }, { actionDigest: "mine" }, { sql: "SELECT 1" }])
        expect((await submit({ ...input, ...extra })).status).toBe(400);
      for (const invalid of [{ ...action, parameters: { year: false } }, { ...action, metricId: "another" }, { ...action, sql: "SELECT 1" }])
        expect((await submit({ ...input, action: invalid })).status).toBe(400);
      expect((await submit(input, "t", "reader", { Cookie: "" })).status).toBe(401);
      expect((await submit(input, "t", "unknown")).status).toBe(403);
      expect((await submit(input, "t", "reader", { Origin: "https://other.test" })).status).toBe(403);
      expect((await submit({ ...input, action: "x".repeat(8193) }, "t", "reader", { "Content-Length": "1" })).status).toBe(413);
      await sql("UPDATE semantic_source_heads SET table_id='changed' WHERE tenant_id='t'");
      expect((await submit()).status).toBe(409);
      expect(await jobSqlite(file, "readonly-first", "SELECT count(*) AS n FROM contract_requests")).toEqual({ n: 0 });
    });
    it("upgrades a populated v17 without backfilling or rewriting historical requests", async () => {
      file = join(dir, "v17.db");
      await jobSqlite(file, "setup-v17");
      await members("t");
      await publishViaApi();
      const before = await counts();
      const unavailable = await submit();
      expect(unavailable.status).toBe(503);
      expect(await unavailable.json()).toEqual({ ok: false, code: "control_storage_unavailable" });
      await jobSqlite(file, "apply-contract-requests");
      expect(await jobSqlite(file, "readonly-first", "SELECT count(*) AS n FROM contract_requests")).toEqual({ n: 0 });
      expect((await submit()).status).toBe(201);
      const original = await jobSqlite(file, "readonly-first", "SELECT * FROM contract_requests");
      await expect(sql("UPDATE contract_requests SET requested_agent_id='changed'")).rejects.toThrow();
      await expect(sql("DELETE FROM contract_requests")).rejects.toThrow();
      await sql("INSERT OR REPLACE INTO contract_requests SELECT tenant_id,principal_id,id,release_id,'changed',action_digest,requested_at FROM contract_requests");
      expect(await jobSqlite(file, "readonly-first", "SELECT * FROM contract_requests")).toEqual(original);
      expect(await counts()).toEqual(before);
    });
    it.each(["retire", "deactivate", "source drift"])("rejects %s committed between compilation and insertion", async change => {
      await publishViaApi();
      let writes = 0;
      const hooked: typeof db = { prepare(query) {
        const prepared = db.prepare(query);
        if (!query.startsWith("INSERT INTO contract_requests")) return prepared;
        return { ...prepared, bind(...params) {
          const bound = prepared.bind(...params);
          return { ...bound, async first<T>() {
            writes++;
            if (change === "retire") expect((await retire("during request")).status).toBe(201);
            else if (change === "deactivate") await sql("UPDATE control_memberships SET active=0 WHERE tenant_id='t' AND principal_id='google:reader'");
            else await sql("UPDATE semantic_source_heads SET source_revision='s2' WHERE tenant_id='t'");
            return bound.first<T>();
          } };
        } };
      } };
      const req = new Request("https://gateway.test/api/control/t/contract-requests", { method: "POST", body: JSON.stringify(input),
        headers: { Cookie: await cookie("reader"), Origin: "https://gateway.test", "Content-Type": "application/json" } });
      const res = await worker.fetch(req, { ...env, DB: hooked }, { waitUntil: () => undefined });
      expect(writes).toBe(1);
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ ok: false, code: "contract_request_not_recorded" });
      expect(await jobSqlite(file, "readonly-first", "SELECT count(*) AS n FROM contract_requests")).toEqual({ n: 0 });
    });
  });

  describe("owner retirement command", () => {
    const input = { releaseId: "published", reason: "superseded" };
    const post = (data: unknown, headers = {}) => postCommand("t/retirements", JSON.stringify(data), "owner", headers);
    async function released(tenant: string) {
      const { definitionDigest } = await propose(tenant);
      await recordSemanticValidation(owner(tenant), "rev", definitionDigest, "fixture:private-evidence");
      await approve(tenant, definitionDigest);
      await publish(tenant);
    }

    it("does not expose an existing retirement to another owner, and isolates duplicate release IDs", async () => {
      await sql("INSERT INTO control_tenants VALUES('peer','Peer')");
      await members("peer");
      await sql("INSERT INTO control_memberships VALUES('t','google:other','owner',1)");
      await released("t");
      await released("peer");
      expect(await review("t", "owner")).toMatchObject({ canRetireRelease: true });
      for (const subject of ["other", "reviewer"]) expect(await review("t", subject)).toMatchObject({ canRetireRelease: false });
      const denied = await retire("before", "other");
      expect(denied.status).toBe(404);
      expect((await retire("real")).status).toBe(201);
      expect(await review("peer")).toMatchObject({ state: "published", retiredAt: null });
      for (const res of [denied, await retire("after", "other"), await retire("missing", "owner", "absent")]) {
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ ok: false, code: "not_found" });
      }
    });

    it("recovers a scoped retirement after losing the commit response, without changing its reason on replay", async () => {
      await released("t");
      const get = await sessionFetch("owner"), signal = new AbortController().signal;
      const prior = await inspectRevision("t", "rev", signal, get);
      if (!prior.ok) throw new Error("Expected owner inspection");
      let writes = 0;
      expect(await submitRetirement(prior.value, "old source", signal, async (path, init) => {
        writes++;
        expect((await get(path, init)).status).toBe(201);
        throw new Error("lost response");
      })).toEqual({ kind: "unknown" });
      expect(writes).toBe(1);
      const current = await inspectRevision("t", "rev", signal, get);
      if (!current.ok) throw new Error("Expected retired snapshot");
      expect(current.value).toMatchObject({ state: "retired", releaseId: "published", retiredAt: expect.any(String), canRetireRelease: false });
      expect(await submitRetirement(prior.value, "new reason", signal, get)).toEqual({
        kind: "alreadyRetired", releaseId: "published", retiredAt: current.value.retiredAt });
      expect(await jobSqlite(file, "readonly-first", "SELECT reason,(SELECT count(*) FROM control_object_events WHERE object_kind='semantic_release_retirement') AS events FROM dispatch_retired_releases"))
        .toEqual({ reason: "old source", events: 1 });
    });

    it("rejects forged fields, cross-origin requests and loss of write authority during upload", async () => {
      await released("t");
      expect((await post(input, { Cookie: "" })).status).toBe(401);
      expect((await post(input, { Origin: "https://elsewhere.test" })).status).toBe(403);
      expect((await retire("denied", "reviewer")).status).toBe(403);
      expect((await fetchLocal(request("t/retirements", await cookie("owner")))).status).toBe(405);
      for (const bad of [{ ...input, retiredBy: "google:owner" }, { ...input, releaseId: "bad/path" },
        { ...input, reason: " " }, { ...input, reason: "\0" }, { ...input, reason: "x".repeat(1025) }]) {
        expect((await post(bad)).status).toBe(400);
      }
      expect((await postCommand("t/retirements", " ".repeat(8193), "owner", { "Content-Length": "1" })).status).toBe(413);
      const delayed = new ReadableStream({ async pull(c) {
        await sql("UPDATE control_memberships SET role='reader' WHERE tenant_id='t' AND principal_id='google:owner'");
        c.enqueue(new TextEncoder().encode(JSON.stringify(input)));
        c.close();
      } }, { highWaterMark: 0 });
      const revoked = await postCommand("t/retirements", delayed, "owner");
      expect(revoked.status).toBe(404);
      expect(await review()).toMatchObject({ state: "published", retiredAt: null });
    });

    it("rolls back the marker on audit failure, suppresses diagnostics and permits retry", async () => {
      await released("t");
      await sql(`CREATE TRIGGER fail_http_retirement BEFORE INSERT ON control_object_events
        WHEN NEW.object_kind='semantic_release_retirement' BEGIN SELECT RAISE(ABORT,'private audit detail'); END`);
      const failed = await post(input);
      expect(failed.status).toBe(503);
      expect(await failed.json()).toEqual({ ok: false, code: "control_storage_unavailable" });
      expect(await review()).toMatchObject({ state: "published", retiredAt: null });
      await sql("DROP TRIGGER fail_http_retirement");
      expect((await post(input)).status).toBe(201);
    });
  });

  describe("exact definition read", () => {
    it("serves the read-only inspection client with the current tenant session and exact bytes", async () => {
      const { definitionDigest } = await propose();
      async function inspect(subject: string) {
        const session = subject ? await cookie(subject) : "";
        return inspectRevision("t", "rev", new AbortController().signal, (url, options) =>
          fetchLocal(new Request(new URL(String(url), "https://gateway.test"), { ...options, headers: { Cookie: session } })));
      }
      const result = await inspect("reviewer");
      expect(result).toMatchObject({ ok: true, value: { tenantId: "t", revisionId: "rev", state: "candidate", definitionDigest } });
      if (!result.ok) throw new Error("Expected a visible definition");
      expect(JSON.parse(result.value.definitionJson)).toEqual(metric);
      expect(await inspect("reader")).toEqual({ ok: false, error: "not_found" });
      expect(await inspect("outsider")).toEqual({ ok: false, error: "forbidden" });
      expect(await inspect("")).toEqual({ ok: false, error: "signed_out" });
    });
    const digestOf = (text: string) => "sha256:" + createHash("sha256").update(text, "utf8").digest("hex");
    const get = async (path = "t/definition/rev", subject = "reviewer") => fetchLocal(request(path, await cookie(subject)));

    it("serves the canonical stored text and a reproducible UTF-8 digest without performing a review action", async () => {
      const value = { ...metric, metricId: 'net revenue "\u20ac"' };
      const submitted = JSON.stringify(value, null, 2);
      const proposed = await proposeSemanticRevision(owner(), { revisionId: "rev", ownerId: "google:owner",
        provenanceRef: "fixture:private-provenance", definitionJson: submitted });
      const stored = await jobSqlite(file, "readonly-first", "SELECT definition_json AS text FROM semantic_candidate_revisions");
      expect(stored.text).not.toBe(submitted);
      const expected = { ok: true, revision: { tenantId: "t", revisionId: "rev", definitionJson: stored.text,
        definitionDigest: digestOf(stored.text) } };
      expect(expected.revision.definitionDigest).toBe(proposed.definitionDigest);
      for (const subject of ["reviewer", "owner"]) {
        const result = await get("t/definition/rev", subject);
        expect(result.status).toBe(200);
        expect(result.headers.get("cache-control")).toBe("no-store");
        expect(await result.json()).toEqual(expected);
      }
      expect(JSON.parse(expected.revision.definitionJson)).toEqual(value);
      const summary = await review();
      expect(summary).toMatchObject({ state: "candidate", validatedAt: null, approvedAt: null, releaseId: null });
      expect(summary).not.toHaveProperty("definitionJson");
      await recordSemanticValidation(owner(), "rev", proposed.definitionDigest, "fixture:private-evidence");
      expect(await (await get()).json()).toEqual(expected);
      expect((await fetchLocal(request("t/definition/rev", await cookie("owner"), "POST"))).status).toBe(405);
    });

    it("separates tenant-local IDs and withholds bytes when membership is missing, revoked or reader-only", async () => {
      await sql("INSERT INTO control_tenants VALUES('peer','Peer')");
      await members("peer");
      const local = await propose(), peer = await propose("peer");
      expect(local.definitionDigest).not.toBe(peer.definitionDigest);
      const response = await get("peer/definition/rev");
      expect(await response.json()).toMatchObject({ revision: { tenantId: "peer", definitionDigest: peer.definitionDigest } });
      expect((await fetchLocal(request("t/definition/rev"))).status).toBe(401);
      expect((await get("t/definition/rev", "outsider")).status).toBe(403);
      const hidden = await get("t/definition/rev", "reader"), missing = await get("t/definition/missing");
      expect([hidden.status, missing.status]).toEqual([404, 404]);
      expect(await hidden.text()).toBe(await missing.text());
      const auth = await authorizeControlRequest(request("t/definition/rev", await cookie("reviewer")), env, "t");
      if (!auth.ok) throw new Error("Expected active reviewer");
      await sql("UPDATE control_memberships SET active=0 WHERE tenant_id='t' AND principal_id='google:reviewer'");
      expect(await readReviewDefinition(auth.access, "rev")).toBeNull();
      expect((await get()).status).toBe(403);
      expect((await get("peer/definition/rev")).status).toBe(200);
    });

    it("does not disclose a record with substituted bytes or noncanonical serialization even when rehashed", async () => {
      const submitted = await propose();
      const { text } = await jobSqlite(file, "readonly-first", "SELECT definition_json AS text FROM semantic_candidate_revisions");
      const substituted = text.replace("net_amount", "gross_amount");
      expect(digestOf(substituted)).not.toBe(submitted.definitionDigest);
      const pretty = JSON.stringify(metric, null, 2);
      for (const [id, content, digest] of [["wrong-digest", substituted, submitted.definitionDigest], ["wrong-format", pretty, digestOf(pretty)]]) {
        // Model damaged storage on separate rows; do not loosen the immutable-write triggers.
        await sql(`INSERT INTO semantic_candidate_revisions
          (tenant_id,id,definition_json,definition_digest,owner_id,provenance_ref,proposed_by)
          VALUES('t',?,?,?,'google:owner','fixture:private-provenance','google:owner')`, [id, content, digest]);
        const res = await get("t/definition/" + id);
        expect(res.status).toBe(503);
        expect(await res.json()).toEqual({ ok: false, code: "control_storage_unavailable" });
      }
    });
  });

  describe("candidate proposal command", () => {
    const origin = "https://gateway.test", url = origin + "/api/control/t/proposals";
    const input = { revisionId: "rev", ownerId: "google:owner", provenanceRef: "fixture:source", definition: metric };
    const total = () => jobSqlite(file, "readonly-first", "SELECT count(*) AS n FROM semantic_candidate_revisions");
    async function post(body: BodyInit = JSON.stringify(input), overrides: Record<string, string> = {},
      subject = "reviewer") {
      return postCommand("t/proposals", body, subject, overrides);
    }

    it("creates exactly one candidate; its author is the signed principal and the returned location is readable", async () => {
      const replies = await Promise.all([post(), post()]);
      expect(replies.map(r => r.status).sort()).toEqual([201, 409]);
      const created = replies.find(r => r.status === 201)!;
      expect(created.headers.get("Location")).toBe("/api/control/t/review/rev");
      expect(created.headers.get("Cache-Control")).toBe("no-store");
      const snapshot = await review();
      expect(snapshot?.state).toBe("candidate");
      expect(await created.json()).toEqual({ ok: true, proposal: { revisionId: "rev", definitionDigest: snapshot?.definitionDigest } });
      expect(await jobSqlite(file, "readonly-first", `SELECT r.proposed_by,r.owner_id,
        (SELECT count(*) FROM semantic_candidate_validations) AS validations,
        (SELECT count(*) FROM semantic_candidate_approvals) AS approvals,
        (SELECT count(*) FROM semantic_release_promotions) AS promotions FROM semantic_candidate_revisions r`))
        .toEqual({ proposed_by: "google:reviewer", owner_id: "google:owner", validations: 0, approvals: 0, promotions: 0 });
    });

    it("requires an exact origin, JSON, a signed provider subject and an authorized tenant role", async () => {
      const noOrigin = new Request(url, { method: "POST", headers: { Cookie: await cookie("owner"), "Content-Type": "application/json" },
        body: JSON.stringify(input) });
      expect((await fetchLocal(noOrigin)).status).toBe(403);
      for (const value of ["null", "http://gateway.test", origin + ".evil.test", origin + ":8443"]) {
        expect((await post(undefined, { Origin: value })).status).toBe(403);
      }
      expect((await post(undefined, { "Content-Type": "text/plain" })).status).toBe(415);
      expect((await post(undefined, { Cookie: "" })).status).toBe(401);
      const state = await signAuthPayload({ provider: "google", nonce: "fixture", returnTo: "/", expiresAt: Date.now() + 60000 }, secret);
      expect((await post(undefined, { Cookie: SESSION_COOKIE + "=" + state })).status).toBe(401);
      expect((await post(undefined, {}, "reader")).status).toBe(403);
      expect((await post(undefined, {}, "outsider")).status).toBe(403);
      expect((await fetchLocal(new Request(url))).status).toBe(405);
      expect(await total()).toEqual({ n: 0 });
    });

    it("rejects forged lifecycle fields, invalid revision IDs, wrong tenant scope and unavailable named owners", async () => {
      for (const value of [{ ...input, approvedBy: "google:owner" }, { ...input, proposedBy: "google:owner" },
        { ...input, definition: { ...metric, state: "approved" } }, { ...input, revisionId: "bad/path" },
        { ...input, definition: { ...metric, tenantId: "peer" } }]) {
        expect((await post(JSON.stringify(value))).status).toBe(400);
      }
      expect((await post(JSON.stringify({ ...input, ownerId: "google:reader" }))).status).toBe(409);
      expect((await post("{")).status).toBe(400);
      expect((await post(new Uint8Array([0xff]))).status).toBe(400);
      expect(await total()).toEqual({ n: 0 });
    });

    it("bounds streamed bytes independently of Content-Length and rechecks the role at insertion", async () => {
      expect((await post(undefined, { "Content-Length": "60000" })).status).toBe(413);
      const chunk = new Uint8Array(30 * 1024).fill(32);
      const oversized = new ReadableStream({ start(c) { c.enqueue(chunk); c.enqueue(chunk); c.close(); } });
      expect((await post(oversized, { "Content-Length": "100" })).status).toBe(413);
      const revokeDuringRead = new ReadableStream({ async pull(c) {
        await sql("UPDATE control_memberships SET role='reader' WHERE tenant_id='t' AND principal_id='google:reviewer'");
        c.enqueue(new TextEncoder().encode(JSON.stringify(input)));
        c.close();
      } }, { highWaterMark: 0 });
      expect((await post(revokeDuringRead)).status).toBe(409);
      expect(await total()).toEqual({ n: 0 });
    });

    it("does not turn a storage outage into a successful proposal or expose database details", async () => {
      await sql("DROP TABLE semantic_candidate_revisions");
      const res = await post();
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ ok: false, code: "control_storage_unavailable" });
    });
  });

  describe("separate owner promotion command", () => {
    const send = (input: unknown = decision, subject = "owner", tenant = "t", headers = {}) =>
      postCommand(tenant + "/promotions", JSON.stringify(input), subject, headers);
    const head = (s = "s1") => sql("INSERT INTO semantic_source_heads VALUES('t','orders','demo-project','analytics','orders',?)", [s]);
    const counts = () => jobSqlite(file, "readonly-first", `SELECT
      (SELECT count(*) FROM semantic_release_promotions) AS promotions,
      (SELECT count(*) FROM semantic_releases) AS releases,
      (SELECT count(*) FROM control_object_events WHERE object_kind='release') AS releaseEvents,
      (SELECT count(*) FROM approval_contracts) AS executionContracts,
      (SELECT count(*) FROM dispatch_targets) AS dispatchTargets`);
    async function approved() {
      const { definitionDigest } = await propose();
      await recordSemanticValidation(owner(), "rev", definitionDigest, "fixture:private-evidence");
      await approve("t", definitionDigest);
    }

    it("publishes only on an explicit client command and checks catalog drift and current ownership", async () => {
      await approved();
      await head();
      await sql("INSERT INTO control_memberships VALUES('t','google:other','owner',1)");
      const scoped = await sessionFetch("owner"), signal = new AbortController().signal;
      const result = await inspectRevision("t", "rev", signal, scoped);
      if (!result.ok) throw new Error("Expected inspected approval");
      expect(result.value).toMatchObject({ state: "approved", canRequestPromotion: true, approvalId: decision.approvalId });
      expect(await review("t", "other")).toMatchObject({ canRequestPromotion: false });
      expect(await review()).toMatchObject({ canRequestPromotion: false });
      const before = await counts();
      await sql("UPDATE semantic_source_heads SET table_id='redirected' WHERE tenant_id='t'");
      expect(await submitPromotion(result.value, "drifted", signal, scoped)).toBe("publicationRefused");
      await sql("UPDATE semantic_source_heads SET table_id='orders' WHERE tenant_id='t'");
      await sql("UPDATE control_memberships SET role='reviewer' WHERE tenant_id='t' AND principal_id='google:owner'");
      expect(await submitPromotion(result.value, "demoted", signal, scoped)).toBe("denied");
      expect(await counts()).toEqual(before);
      await sql("UPDATE control_memberships SET role='owner' WHERE tenant_id='t' AND principal_id='google:owner'");
      const lost: typeof fetch = async (url, init) => {
        expect((await scoped(url, init)).status).toBe(201);
        throw new Error("Response lost after commit");
      };
      expect(await submitPromotion(result.value, "issued", signal, lost)).toBe("unknown");
      const fresh = await inspectRevision("t", "rev", signal, scoped);
      expect(fresh).toMatchObject({ ok: true, value: { state: "published", releaseId: "issued", canRequestPromotion: false } });
      expect(await (await scoped("/api/control/t/release/issued")).json()).toMatchObject({
        object: { id: "issued", state: "released", definitionDigest: result.value.definitionDigest } });
      expect(await counts()).toEqual({ ...before, promotions: before.promotions + 1, releases: before.releases + 1,
        releaseEvents: before.releaseEvents + 1 });
    });

    it("publishes one release from the authenticated review flow and never enables dispatch", async () => {
      const before = await counts();
      expect((await postCommand("t/proposals", JSON.stringify({ revisionId: "rev", ownerId: "google:owner",
        provenanceRef: "fixture:source", definition: metric }), "reviewer")).status).toBe(201);
      const detail = await fetchLocal(request("t/definition/rev", await cookie("owner")));
      const { revision } = await detail.json() as { revision: { definitionJson: string } };
      const reviewedDigest = "sha256:" + createHash("sha256").update(revision.definitionJson).digest("hex");
      const validation = { revisionId: "rev", reviewedDigest, evidenceRef: "fixture:check" };
      expect((await postCommand("t/validations", JSON.stringify(validation), "owner")).status).toBe(201);
      expect((await send()).status).toBe(409);
      expect((await postCommand("t/approvals", JSON.stringify({ ...validation, approvalId: "decision" }), "owner")).status).toBe(201);
      await head();
      const ids = ["issue-one", "issue-two"];
      const replies = await Promise.all(ids.map(releaseId => send({ ...decision, releaseId })));
      expect(replies.map(r => r.status).sort()).toEqual([201, 409]);
      const winner = replies.findIndex(r => r.status === 201), releaseId = ids[winner];
      expect(replies[winner].headers.get("Location")).toBe("/api/control/t/release/" + releaseId);
      expect(replies[winner].headers.get("Cache-Control")).toBe("no-store");
      expect(await replies[winner].json()).toEqual({ ok: true, promotion: { releaseId } });
      const issued = await fetchLocal(request("t/release/" + releaseId, await cookie("reader")));
      expect(await issued.json()).toMatchObject({ ok: true, object: { id: releaseId, definitionDigest: reviewedDigest, state: "released" } });
      expect(await review()).toMatchObject({ state: "published", releaseId, publishedAt: expect.any(String) });
      expect(await counts()).toEqual({ ...before, promotions: before.promotions + 1,
        releases: before.releases + 1, releaseEvents: before.releaseEvents + 1 });
    });

    it("refuses missing or changed catalog, existing release IDs, and a withdrawn approval without any partial write", async () => {
      await approved();
      const before = await counts();
      expect((await send()).status).toBe(409);
      await head("new-source");
      expect((await send()).status).toBe(409);
      await sql("UPDATE semantic_source_heads SET source_revision='s1',table_id='other'");
      expect((await send()).status).toBe(409);
      await sql("UPDATE semantic_source_heads SET table_id='orders'");
      expect((await send({ ...decision, releaseId: "r" })).status).toBe(409);
      await withdrawSemanticApproval(owner(), { ...decision, reason: "fixture:withdraw" });
      expect((await send()).status).toBe(409);
      expect(await counts()).toEqual(before);
    });

    it("rejects forged payloads, wrong tenant or owner, cross-origin and revoked authority", async () => {
      await approved();
      await head();
      const before = await counts();
      await sql("INSERT INTO control_memberships VALUES('t','google:other','owner',1)");
      await sql("INSERT INTO control_tenants VALUES('peer','Peer')");
      await members("peer");
      expect((await send(decision, "owner", "peer")).status).toBe(409);
      expect((await send(decision, "other")).status).toBe(409);
      expect((await send(decision, "reviewer")).status).toBe(403);
      expect((await send(decision, "owner", "t", { Origin: "https://elsewhere.test" })).status).toBe(403);
      expect((await send(decision, "owner", "t", { Cookie: "" })).status).toBe(401);
      expect((await postCommand("t/promotions", " ".repeat(8193), "owner", { "Content-Length": "1" })).status).toBe(413);
      for (const invalid of [{ ...decision, ownerId: "google:owner" }, { ...decision, sourceRevision: "s1" },
        { ...decision, release: metric }, { ...decision, releaseId: "bad/path" }]) {
        expect((await send(invalid)).status).toBe(400);
      }
      await sql("UPDATE control_memberships SET active=0 WHERE tenant_id='t' AND principal_id='google:owner'");
      expect((await send()).status).toBe(403);
      expect(await counts()).toEqual(before);
    });

    it("treats unexpected audit failure as unavailable, rolls back and permits a clean retry", async () => {
      await approved();
      await head();
      const before = await counts();
      await sql(`CREATE TRIGGER fail_http_audit BEFORE INSERT ON control_object_events WHEN NEW.object_kind='release'
        BEGIN SELECT RAISE(ABORT,'unexpected: semantic promotion unavailable'); END`);
      const failed = await send();
      expect(failed.status).toBe(503);
      expect(await failed.json()).toEqual({ ok: false, code: "control_storage_unavailable" });
      expect(await counts()).toEqual(before);
      await sql("DROP TRIGGER fail_http_audit");
      expect((await send()).status).toBe(201);
      expect((await fetchLocal(request("t/promotions", await cookie("owner")))).status).toBe(405);
    });

    describe("owner withdrawal versus publication over HTTP", () => {
      async function openApproval() {
        await approved();
        const scoped = await sessionFetch("owner"), signal = new AbortController().signal;
        const inspected = await inspectRevision("t", "rev", signal, scoped);
        if (!inspected.ok || !inspected.value.canWithdrawApproval) throw new Error("Expected withdrawable approval");
        return { value: inspected.value, signal, scoped };
      }

      it("handles a lost withdrawal response and a stale client replay without overwriting the first reason", async () => {
        const { value, signal, scoped } = await openApproval();
        await sql("INSERT INTO control_memberships VALUES('t','google:other','owner',1)");
        expect(await review("t", "other")).toMatchObject({ canWithdrawApproval: false });
        expect(await review()).toMatchObject({ canWithdrawApproval: false });
        expect(await submitWithdrawal(value, "denied", signal, await sessionFetch("other"))).toEqual({ kind: "denied" });
        const lost: typeof fetch = async (path, init) => {
          const reply = await scoped(path, init);
          if (reply.status !== 201) return reply;
          throw new Error("Response lost after commit");
        };
        expect(await submitWithdrawal(value, "fixture:first", signal, lost)).toEqual({ kind: "unknown" });
        const fresh = await inspectRevision("t", "rev", signal, scoped);
        if (!fresh.ok) throw new Error("Expected withdrawn snapshot");
        expect(fresh.value).toMatchObject({ state: "withdrawn", withdrawnAt: expect.any(String), canWithdrawApproval: false });
        expect(await submitWithdrawal(value, "fixture:retry", signal, scoped)).toEqual({
          kind: "alreadyWithdrawn", approvalId: decision.approvalId, withdrawnAt: fresh.value.withdrawnAt });
        expect(await jobSqlite(file, "readonly-first", "SELECT reason FROM semantic_approval_withdrawals")).toEqual({ reason: "fixture:first" });
        expect(await history()).toEqual({ withdrawals: 1, events: 1, retirements: 0 });
      });

      it("returns the actual release when publication wins after the client inspected the approval", async () => {
        const { value, signal, scoped } = await openApproval();
        await head();
        expect(await submitPromotion(value, "first-release", signal, scoped)).toBe("published");
        expect(await submitWithdrawal(value, "too late", signal, scoped)).toEqual({
          kind: "publicationWon", approvalId: decision.approvalId, releaseId: "first-release" });
        expect(await review()).toMatchObject({ state: "published", releaseId: "first-release", withdrawnAt: null, retiredAt: null });
        expect(await history()).toEqual({ withdrawals: 0, events: 0, retirements: 0 });
      });
      const input = { revisionId: "rev", approvalId: "decision", reason: "fixture:wrong-measure" };
      const withdraw = (value: unknown = input, subject = "owner", tenant = "t", headers = {}) =>
        postCommand(tenant + "/withdrawals", JSON.stringify(value), subject, headers);
      const history = () => jobSqlite(file, "readonly-first", `SELECT
        (SELECT count(*) FROM semantic_approval_withdrawals) AS withdrawals,
        (SELECT count(*) FROM control_object_events WHERE object_kind='semantic_approval_withdrawal') AS events,
        (SELECT count(*) FROM dispatch_retired_releases) AS retirements`);

      it("returns the original instant on retry without replacing the reason or issuing a release", async () => {
        await approved();
        await head();
        const before = await counts(), first = await withdraw();
        expect(first.status).toBe(201);
        expect(first.headers.get("Location")).toBe("/api/control/t/review/rev");
        expect(first.headers.get("Cache-Control")).toBe("no-store");
        const snapshot = await review();
        expect(snapshot).toMatchObject({ state: "withdrawn", withdrawnAt: expect.any(String), releaseId: null });
        expect(await first.json()).toEqual({ ok: true, withdrawal: { status: "withdrawn", withdrawnAt: snapshot?.withdrawnAt } });
        const replay = await withdraw({ ...input, reason: "fixture:changed" });
        expect(replay.status).toBe(200);
        expect(await replay.json()).toEqual({ ok: true, withdrawal: { status: "already_withdrawn", withdrawnAt: snapshot?.withdrawnAt } });
        expect(await jobSqlite(file, "readonly-first", "SELECT reason,withdrawn_by FROM semantic_approval_withdrawals"))
          .toEqual({ reason: input.reason, withdrawn_by: "google:owner" });
        expect((await send()).status).toBe(409);
        expect(await counts()).toEqual(before);
        expect(await history()).toEqual({ withdrawals: 1, events: 1, retirements: 0 });
      });

      it("returns the actual result of racing both signed commands; a prior publication is not a withdrawal", async () => {
        await approved();
        await head();
        const before = await counts();
        const [promotion, withdrawal] = await Promise.all([send(), withdraw()]);
        const published = promotion.status === 201;
        expect([promotion.status, withdrawal.status]).toEqual(published ? [201, 409] : [409, 201]);
        if (published) expect(await withdrawal.json()).toEqual({ ok: false, code: "already_promoted", releaseId: decision.releaseId });
        else expect(await withdrawal.json()).toMatchObject({ ok: true, withdrawal: { status: "withdrawn" } });
        expect(await review()).toMatchObject({ state: published ? "published" : "withdrawn", releaseId: published ? decision.releaseId : null });
        expect(await counts()).toEqual({ ...before, releases: before.releases + Number(published),
          promotions: before.promotions + Number(published), releaseEvents: before.releaseEvents + Number(published) });
        expect(await history()).toEqual({ withdrawals: Number(!published), events: Number(!published), retirements: 0 });
      });

      it("only discloses a prior release ID to the active approving owner for that tenant and revision", async () => {
        await approved();
        await head();
        expect((await send()).status).toBe(201);
        const before = await counts();
        const conflict = await withdraw();
        expect(conflict.status).toBe(409);
        expect(await conflict.json()).toEqual({ ok: false, code: "already_promoted", releaseId: decision.releaseId });
        await sql("INSERT INTO control_memberships VALUES('t','google:other','owner',1)");
        await sql("INSERT INTO control_tenants VALUES('peer','Peer')");
        await members("peer");
        for (const denied of [await withdraw(input, "other"), await withdraw(input, "owner", "peer"),
          await withdraw({ ...input, revisionId: "wrong" })]) {
          expect(denied.status).toBe(404);
          expect(await denied.json()).toEqual({ ok: false, code: "not_found" });
        }
        expect((await withdraw(input, "reviewer")).status).toBe(403);
        expect((await withdraw(input, "owner", "t", { Origin: "https://elsewhere.test" })).status).toBe(403);
        expect((await withdraw(input, "owner", "t", { Cookie: "" })).status).toBe(401);
        expect((await withdraw({ ...input, withdrawnBy: "google:owner" })).status).toBe(400);
        expect((await withdraw({ ...input, reason: "  " })).status).toBe(400);
        expect((await postCommand("t/withdrawals", " ".repeat(8193), "owner", { "Content-Length": "1" })).status).toBe(413);
        const delayed = new ReadableStream({ async pull(c) {
          await sql("UPDATE control_memberships SET active=0 WHERE tenant_id='t' AND principal_id='google:owner'");
          c.enqueue(new TextEncoder().encode(JSON.stringify(input)));
          c.close();
        } }, { highWaterMark: 0 });
        const revoked = await postCommand("t/withdrawals", delayed, "owner");
        expect(revoked.status).toBe(404);
        expect(await revoked.json()).toEqual({ ok: false, code: "not_found" });
        expect(await counts()).toEqual(before);
        expect(await history()).toEqual({ withdrawals: 0, events: 0, retirements: 0 });
      });

      it("reports audit failure without claiming withdrawal; the same command can be retried", async () => {
        await approved();
        await sql(`CREATE TRIGGER fail_http_withdrawal BEFORE INSERT ON control_object_events
          WHEN NEW.object_kind='semantic_approval_withdrawal' BEGIN SELECT RAISE(ABORT,'private audit detail'); END`);
        const failed = await withdraw();
        expect(failed.status).toBe(503);
        expect(await failed.json()).toEqual({ ok: false, code: "control_storage_unavailable" });
        expect(await history()).toEqual({ withdrawals: 0, events: 0, retirements: 0 });
        expect(await review()).toMatchObject({ state: "approved" });
        await sql("DROP TRIGGER fail_http_withdrawal");
        expect((await withdraw()).status).toBe(201);
        expect((await fetchLocal(request("t/withdrawals", await cookie("owner")))).status).toBe(405);
      });
    });
  });

  describe("explicit owner approval command", () => {
    const basis = async (tenant: string, subject: string) =>
      fetchLocal(request(tenant + "/approval-basis/rev", await cookie(subject)));
    it("keeps recorded evidence out of shared reads and isolates equal revision IDs", async () => {
      await sql("INSERT INTO control_tenants VALUES('peer','Peer')");
      await members("peer");
      await sql("INSERT INTO control_memberships VALUES('t','google:other','owner',1)");
      for (const tenant of ["t", "peer"]) {
        const { definitionDigest } = await propose(tenant);
        expect((await basis(tenant, "owner")).status).toBe(404);
        await recordSemanticValidation(owner(tenant), "rev", definitionDigest, "private:" + tenant);
        const res = await basis(tenant, "owner");
        expect(res.headers.get("Cache-Control")).toBe("no-store");
        expect(await res.json()).toEqual({ ok: true, basis: { tenantId: tenant, revisionId: "rev",
          definitionDigest, evidenceRef: "private:" + tenant } });
        const snapshot = await review(tenant, "owner");
        expect(snapshot?.canReviewApproval).toBe(true);
        expect(JSON.stringify(snapshot)).not.toContain("private:");
      }
      for (const subject of ["other", "reviewer", "reader"]) {
        const denied = await basis("t", subject);
        expect(denied.status).toBe(404);
        expect(await denied.json()).toEqual({ ok: false, code: "not_found" });
      }
      expect((await fetchLocal(request("t/approval-basis/rev"))).status).toBe(401);
      expect((await basis("peer", "other")).status).toBe(403);
    });

    it("requires a second decision after inspection; rejects stale authority and closes the basis after approval", async () => {
      const { definitionDigest } = await propose();
      await recordSemanticValidation(owner(), "rev", definitionDigest, "private:review");
      const scopedFetch = await sessionFetch("owner"), signal = new AbortController().signal;
      const opening = await counts();
      const inspected = await inspectRevision("t", "rev", signal, scopedFetch);
      if (!inspected.ok) throw new Error("Expected verified definition and owner evidence");
      expect(inspected.value.approvalEvidence).toBe("private:review");
      expect(await counts()).toEqual(opening);
      await sql("UPDATE control_memberships SET role='reviewer' WHERE tenant_id='t' AND principal_id='google:owner'");
      expect((await basis("t", "owner")).status).toBe(404);
      expect(await submitApproval(inspected.value, "refused", signal, scopedFetch)).toBe("denied");
      await sql("UPDATE control_memberships SET role='owner' WHERE tenant_id='t' AND principal_id='google:owner'");
      expect(await submitApproval(inspected.value, "accepted", signal, scopedFetch)).toBe("approved");
      expect(await submitApproval(inspected.value, "late", signal, scopedFetch)).toBe("conflict");
      expect((await basis("t", "owner")).status).toBe(404);
      expect(await review("t", "owner")).toMatchObject({ state: "approved", approvalId: "accepted", canReviewApproval: false, releaseId: null });
      expect(await counts()).toEqual({ ...opening, approvals: opening.approvals + 1 });
    });

    const approval = (reviewedDigest: string) => ({ revisionId: "rev", approvalId: "decision",
      reviewedDigest, evidenceRef: "fixture:owner-evidence" });
    const send = (data: unknown, subject = "owner", tenant = "t", headers = {}) =>
      postCommand(tenant + "/approvals", JSON.stringify(data), subject, headers);
    const counts = () => jobSqlite(file, "readonly-first", `SELECT
      (SELECT count(*) FROM semantic_candidate_approvals) AS approvals,
      (SELECT count(*) FROM semantic_release_promotions) AS promotions,
      (SELECT count(*) FROM approval_contracts) AS executionContracts`);

    it("runs proposal to explicit approval over HTTP, with one winning decision and no execution authority", async () => {
      const opening = await counts();
      expect((await postCommand("t/proposals", JSON.stringify({ revisionId: "rev", ownerId: "google:owner",
        provenanceRef: "fixture:source", definition: metric }), "reviewer")).status).toBe(201);
      const res = await fetchLocal(request("t/definition/rev", await cookie("owner")));
      const { revision } = await res.json() as { revision: { definitionJson: string } };
      const input = approval("sha256:" + createHash("sha256").update(revision.definitionJson).digest("hex"));
      expect((await send(input)).status).toBe(409);
      const { revisionId, evidenceRef, reviewedDigest } = input;
      expect((await postCommand("t/validations", JSON.stringify({ revisionId, evidenceRef, reviewedDigest }), "owner")).status).toBe(201);
      expect((await send({ ...input, evidenceRef: "fixture:substitute" })).status).toBe(409);
      expect((await send({ ...input, reviewedDigest: "sha256:" + "f".repeat(64) })).status).toBe(409);
      expect(await counts()).toEqual(opening);
      const ids = ["decision-one", "decision-two"];
      const replies = await Promise.all(ids.map(approvalId => send({ ...input, approvalId })));
      expect(replies.map(r => r.status).sort()).toEqual([201, 409]);
      const winner = replies.findIndex(r => r.status === 201);
      expect(replies[winner].headers.get("Cache-Control")).toBe("no-store");
      expect(replies[winner].headers.get("Location")).toBe("/api/control/t/review/rev");
      expect(await replies[winner].json()).toEqual({ ok: true, approval: { approvalId: ids[winner], revisionId } });
      expect(await review()).toMatchObject({ state: "approved", approvalId: ids[winner], releaseId: null, publishedAt: null });
      expect(await counts()).toEqual({ ...opening, approvals: opening.approvals + 1 });
    });

    it("rejects forged approvals, cross-origin requests and authority borrowed from another tenant or owner", async () => {
      const input = approval((await propose()).definitionDigest);
      await recordSemanticValidation(owner(), "rev", input.reviewedDigest, input.evidenceRef);
      await sql("INSERT INTO control_memberships VALUES('t','google:other','owner',1)");
      await sql("INSERT INTO control_tenants VALUES('peer','Peer')");
      await members("peer");
      const peer = await propose("peer");
      await recordSemanticValidation(owner("peer"), "rev", peer.definitionDigest, input.evidenceRef);
      expect((await send(input, "reviewer")).status).toBe(403);
      expect((await send(input, "other")).status).toBe(409);
      expect((await send(input, "owner", "peer")).status).toBe(409);
      expect((await send(input, "owner", "t", { Origin: "https://elsewhere.test" })).status).toBe(403);
      expect((await send(input, "owner", "t", { Cookie: "" })).status).toBe(401);
      expect((await postCommand("t/approvals", " ".repeat(8193), "owner", { "Content-Length": "1" })).status).toBe(413);
      for (const invalid of [{ ...input, approvedBy: "google:owner" }, { ...input, releaseId: "injected" },
        { ...input, approvalId: "bad/id" }, { ...input, evidenceRef: " " }]) {
        expect((await send(invalid)).status).toBe(400);
      }
      const delayed = new ReadableStream({ async pull(c) {
        await sql("UPDATE control_memberships SET role='reviewer' WHERE tenant_id='t' AND principal_id='google:owner'");
        c.enqueue(new TextEncoder().encode(JSON.stringify(input)));
        c.close();
      } }, { highWaterMark: 0 });
      expect((await postCommand("t/approvals", delayed, "owner")).status).toBe(409);
      expect((await counts()).approvals).toBe(0);
      expect((await send({ ...input, reviewedDigest: peer.definitionDigest }, "owner", "peer")).status).toBe(201);
      expect(await review()).toMatchObject({ state: "validated" });
    });

    it("reports storage failure without creating an approval or exposing evidence or database details", async () => {
      const input = approval((await propose()).definitionDigest);
      await recordSemanticValidation(owner(), "rev", input.reviewedDigest, input.evidenceRef);
      await sql(`CREATE TRIGGER fail_fixture_approval BEFORE INSERT ON semantic_candidate_approvals
        BEGIN SELECT RAISE(ABORT,'private fixture diagnostic'); END`);
      const failed = await send(input);
      expect(failed.status).toBe(503);
      expect(await failed.json()).toEqual({ ok: false, code: "control_storage_unavailable" });
      expect((await counts()).approvals).toBe(0);
      expect((await fetchLocal(request("t/approvals", await cookie("owner")))).status).toBe(405);
    });
  });

  describe("owner validation command", () => {
    it("binds the UI command to the inspected revision and rechecks its owner at submission", async () => {
      const { definitionDigest } = await propose();
      await sql("INSERT INTO control_memberships VALUES('t','google:other','owner',1)");
      expect(await review("t", "other")).toMatchObject({ canRecordValidation: false });
      expect(await review("t", "reviewer")).toMatchObject({ canRecordValidation: false });
      const fetchAsOwner = await sessionFetch("owner"), signal = new AbortController().signal;
      const result = await inspectRevision("t", "rev", signal, fetchAsOwner);
      if (!result.ok) throw new Error("Expected a visible revision");
      expect(result.value.canRecordValidation).toBe(true);
      await sql("UPDATE control_memberships SET role='reviewer' WHERE tenant_id='t' AND principal_id='google:owner'");
      expect(await submitValidation(result.value, "fixture:refused", signal, fetchAsOwner)).toBe("denied");
      await sql("UPDATE control_memberships SET role='owner' WHERE tenant_id='t' AND principal_id='google:owner'");
      expect(await submitValidation(result.value, "fixture:verified", signal, fetchAsOwner)).toBe("recorded");
      expect(await submitValidation(result.value, "fixture:replay", signal, fetchAsOwner)).toBe("conflict");
      expect(await review("t", "owner")).toMatchObject({ canRecordValidation: false, state: "validated", approvedAt: null, releaseId: null });
      expect(await jobSqlite(file, "readonly-first", "SELECT definition_digest,evidence_ref FROM semantic_candidate_validations"))
        .toEqual({ definition_digest: definitionDigest, evidence_ref: "fixture:verified" });
    });

    const send = (value: unknown, subject = "owner", tenant = "t", headers = {}) =>
      postCommand(tenant + "/validations", JSON.stringify(value), subject, headers);
    const makeInput = (digest: string) => ({ revisionId: "rev", reviewedDigest: digest, evidenceRef: "fixture:manual-check" });
    const count = () => jobSqlite(file, "readonly-first", "SELECT count(*) AS n FROM semantic_candidate_validations");

    it("records the inspected bytes once and leaves approval and publication untouched", async () => {
      await propose();
      const response = await fetchLocal(request("t/definition/rev", await cookie("owner")));
      const { revision } = await response.json() as { revision: { definitionJson: string } };
      const input = makeInput("sha256:" + createHash("sha256").update(revision.definitionJson).digest("hex"));
      const attempts = [input, { ...input, evidenceRef: "fixture:another-check" }];
      const replies = await Promise.all(attempts.map(value => send(value)));
      expect(replies.map(r => r.status).sort()).toEqual([201, 409]);
      const winner = replies.findIndex(r => r.status === 201);
      expect(replies[winner].headers.get("Location")).toBe("/api/control/t/review/rev");
      expect(replies[winner].headers.get("Cache-Control")).toBe("no-store");
      expect(await replies[winner].json()).toEqual({ ok: true, validation: { revisionId: "rev", definitionDigest: input.reviewedDigest } });
      expect(await review()).toMatchObject({ state: "validated", approvedAt: null, releaseId: null });
      expect(await jobSqlite(file, "readonly-first", `SELECT validated_by,evidence_ref,
        (SELECT count(*) FROM semantic_candidate_approvals) AS approvals,
        (SELECT count(*) FROM semantic_release_promotions) AS promotions FROM semantic_candidate_validations`))
        .toEqual({ validated_by: "google:owner", evidence_ref: attempts[winner].evidenceRef, approvals: 0, promotions: 0 });
    });

    it("rejects a mismatched digest, other owners, peer revisions, forged fields and cross-origin requests", async () => {
      const input = makeInput((await propose()).definitionDigest);
      await sql("INSERT INTO control_tenants VALUES('peer','Peer')");
      await members("peer");
      await propose("peer");
      await sql("INSERT INTO control_memberships VALUES('t','google:other','owner',1)");
      expect((await send(input, "reviewer")).status).toBe(403);
      expect((await send(input, "other")).status).toBe(409);
      expect((await send(input, "owner", "peer")).status).toBe(409);
      expect((await send(input, "owner", "t", { Cookie: "" })).status).toBe(401);
      expect((await send(input, "owner", "t", { Origin: "https://elsewhere.test" })).status).toBe(403);
      expect((await send(input, "owner", "t", { "Content-Type": "text/plain" })).status).toBe(415);
      for (const data of [{ ...input, validatedBy: "google:owner" }, { ...input, state: "approved" },
        { ...input, reviewedDigest: "not-a-digest" }, { ...input, evidenceRef: " " }]) {
        expect((await send(data)).status).toBe(400);
      }
      expect((await fetchLocal(request("t/validations", await cookie("owner")))).status).toBe(405);
      expect(await count()).toEqual({ n: 0 });
    });

    it("limits actual bytes and refuses the owner's command after authority is lost during upload", async () => {
      const input = makeInput((await propose()).definitionDigest);
      expect((await postCommand("t/validations", " ".repeat(8193), "owner", { "Content-Length": "1" })).status).toBe(413);
      const delayed = new ReadableStream({ async pull(c) {
        await sql("UPDATE control_memberships SET role='reviewer' WHERE principal_id='google:owner' AND tenant_id='t'");
        c.enqueue(new TextEncoder().encode(JSON.stringify(input)));
        c.close();
      } }, { highWaterMark: 0 });
      expect((await postCommand("t/validations", delayed, "owner")).status).toBe(409);
      expect(await count()).toEqual({ n: 0 });
    });

    it("fails closed on corrupt stored content even if the request supplies its recorded digest", async () => {
      const input = makeInput((await propose()).definitionDigest);
      await sql(`INSERT INTO semantic_candidate_revisions
        (tenant_id,id,definition_json,definition_digest,owner_id,provenance_ref,proposed_by)
        SELECT tenant_id,'damaged',replace(definition_json,'net_amount','gross_amount'),definition_digest,
          owner_id,provenance_ref,proposed_by FROM semantic_candidate_revisions WHERE id='rev'`);
      const denied = await send({ ...input, revisionId: "damaged" });
      expect(denied.status).toBe(503);
      expect(await denied.json()).toEqual({ ok: false, code: "control_storage_unavailable" });
      expect(await count()).toEqual({ n: 0 });
    });
  });
});
