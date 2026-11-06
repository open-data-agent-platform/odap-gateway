import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../worker";
import { SESSION_COOKIE, signAuthPayload } from "../lib/auth";
import { InvalidRequestedAction, prepareMetricPreview } from "../lib/metric-preview";
import { approveSemanticRevision, promoteSemanticRevision, proposeSemanticRevision, recordSemanticValidation,
  retireSemanticRelease } from "../lib/semantic-candidate-storage";
import { jobDatabase, jobSqlite } from "./fixtures/job-sqlite";
import metric from "./fixtures/revenue-metric.json";

let dir: string, file: string;
const db = jobDatabase(() => file);
const readOnly = jobDatabase(() => file, "readonly");
const action = { profile: "odap.metric-read.v1", target: "orders", metricId: "revenue", parameters: { year: 2026 } };
const sql = (q: string, args: string[] = []) => jobSqlite(file, "run", q, args);
const owner = (tenantId: string) => ({ db, tenantId, principalId: "owner" });
const preview = (tenantId = "t", principalId = "user", input: unknown = action, releaseId = "shared") =>
  prepareMetricPreview({ db: readOnly, tenantId, principalId }, releaseId, input);

async function publish(tenantId: string, project: string) {
  const access = owner(tenantId);
  const revisionId = "v1", approvalId = "decision";
  const { definitionDigest } = await proposeSemanticRevision(access, { revisionId, ownerId: access.principalId,
    provenanceRef: "fixture", definitionJson: JSON.stringify({ ...metric, tenantId, table: { ...metric.table, project } }) });
  await recordSemanticValidation(access, revisionId, definitionDigest, "fixture");
  await approveSemanticRevision(access, { approvalId, revisionId, reviewedDigest: definitionDigest, evidenceRef: "fixture" });
  await sql("INSERT INTO semantic_source_heads VALUES(?,'orders',?,'analytics','orders','s1')", [tenantId, project]);
  await promoteSemanticRevision(access, { releaseId: "shared", revisionId, approvalId });
  return definitionDigest;
}

describe("read-only governed metric preview preparation", { timeout: 25000 }, () => {
  beforeEach(async () => {
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected outbound call"); }));
    dir = await mkdtemp(join(tmpdir(), "odap-metric-preview-"));
    file = join(dir, "preview.db");
    await jobSqlite(file, "setup");
  });
  afterEach(async () => {
    const outbound = vi.mocked(fetch);
    vi.unstubAllGlobals();
    await rm(dir, { recursive: true, force: true });
    expect(outbound).not.toHaveBeenCalled();
  });

  it("binds colliding release IDs to each reader's own project and does not fall back after retirement", async () => {
    await sql("INSERT INTO control_tenants VALUES('peer','Peer')");
    await sql("INSERT INTO control_memberships VALUES('peer','owner','owner',1),('peer','peer-user','reader',1)");
    const localDigest = await publish("t", "demo-project");
    const peerDigest = await publish("peer", "peer-project");
    expect(peerDigest).not.toBe(localDigest);
    for (const [tenant, reader, project, definitionDigest] of [
      ["t", "user", "demo-project", localDigest], ["peer", "peer-user", "peer-project", peerDigest]
    ]) {
      expect(await preview(tenant, reader)).toEqual({ releaseId: "shared", projectId: project, definitionDigest,
        actionDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/), compiled: {
          query: "SELECT SUM(`net_amount`) AS metric_value FROM `" + project + ".analytics.orders` WHERE `order_year` = @p0",
          useLegacySql: false, parameterMode: "NAMED",
          queryParameters: [{ name: "p0", parameterType: { type: "INT64" }, parameterValue: { value: "2026" } }]
        } });
    }
    expect(await preview("peer", "user")).toBeNull();
    expect(await preview("t", "peer-user")).toBeNull();
    await retireSemanticRelease(owner("t"), "shared", "fixture");
    expect(await preview()).toBeNull();
    expect((await preview("peer", "peer-user"))?.definitionDigest).toBe(peerDigest);
  });

  it("rejects editor SQL and caller-supplied overrides without authorizing or pricing the action", async () => {
    await publish("t", "demo-project");
    for (const invalid of ["SELECT 1", { ...action, sql: "SELECT 1" }, { ...action, projectId: "peer-project" },
      { ...action, parameters: { year: "2026 OR 1=1" } }]) {
      await expect(preview("t", "user", invalid)).rejects.toBeInstanceOf(InvalidRequestedAction);
    }
    expect(await preview("t", "user", action, "r")).toBeNull(); // Historical release without a promotion.
    await sql("UPDATE control_memberships SET active=0 WHERE tenant_id='t' AND principal_id='user'");
    expect(await preview()).toBeNull();
    expect(await preview("t", "user", "SELECT 1")).toBeNull(); // No validation detail for ineligible readers.
    expect(await preview("t", "owner")).not.toBeNull();
    await sql("UPDATE semantic_source_heads SET project_id='peer-project' WHERE tenant_id='t'");
    expect(await preview("t", "owner")).toBeNull();
  });

  describe("authenticated metric preview HTTP route", () => {
    const env = { AUTH_COOKIE_SECRET: "synthetic-metric-preview-session", GATEWAY_MODE: "production" as const,
      DB: readOnly, ASSETS: { fetch: async () => { throw new Error("Unexpected asset request"); } } };
    const origin = "https://gateway.test";
    const payload = { releaseId: "shared", action };
    let cookie: string;
    const post = (tenant: string, data: unknown, headers: Record<string, string> = {}, bindings = env) =>
      worker.fetch(new Request(origin + "/api/control/" + tenant + "/metric-previews", { method: "POST",
        headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json", ...headers }, body: JSON.stringify(data) }),
        bindings, { waitUntil: () => undefined });
    beforeEach(async () => {
      await sql("INSERT INTO control_memberships VALUES('t','google:alice','reader',1)");
      cookie = SESSION_COOKIE + "=" + await signAuthPayload({ provider: "google", providerId: "alice",
        name: "Fixture", email: "reader@example.test", expiresAt: Date.now() + 60000 }, env.AUTH_COOKIE_SECRET);
    });

    it("returns only a compilation summary and hides unavailable releases regardless of cause", async () => {
      await publish("t", "demo-project");
      const result = await post("t", payload);
      expect(result.status).toBe(200);
      expect(result.headers.get("Cache-Control")).toBe("no-store");
      expect(await result.json()).toEqual({ ok: true, preview: { state: "compiled", releaseId: "shared", parameterCount: 1 } });
      await retireSemanticRelease(owner("t"), "shared", "fixture");
      for (const releaseId of ["shared", "missing", "r"]) {
        const res = await post("t", { ...payload, releaseId });
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ ok: false, code: "metric_preview_unavailable" });
      }
    });

    it("requires a signed session and current membership in the path tenant, not client identity headers", async () => {
      await sql("INSERT INTO control_tenants VALUES('peer','Peer')");
      await sql("INSERT INTO control_memberships VALUES('peer','owner','owner',1),('peer','google:bob','reader',1)");
      await publish("peer", "peer-project");
      const spoof = { "X-Tenant-Id": "t", "X-Principal-Id": "google:bob" };
      expect((await post("peer", payload, { ...spoof, Cookie: "" })).status).toBe(401);
      const denied = await post("peer", payload, spoof);
      expect(denied.status).toBe(403);
      expect(await denied.json()).toEqual({ ok: false, code: "tenant_access_denied" });
      expect((await post("t", payload, spoof)).status).toBe(404);
      await sql("UPDATE control_memberships SET active=0 WHERE tenant_id='t' AND principal_id='google:alice'");
      expect((await post("t", payload)).status).toBe(403);
    });

    it("rejects oversized, cross-origin, raw SQL and identity overrides without echoing inputs", async () => {
      await publish("t", "demo-project");
      expect((await post("t", payload, { Origin: "https://other.test" })).status).toBe(403);
      expect((await post("t", payload, { "Content-Type": "text/plain" })).status).toBe(415);
      expect((await post("t", { ...payload, action: "x".repeat(8193) }, { "Content-Length": "1" })).status).toBe(413);
      for (const data of [{ ...payload, sql: "SELECT private_value" }, { ...payload, principalId: "owner" },
        { ...payload, releaseId: "../peer" }]) {
        const res = await post("t", data);
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ ok: false, code: "invalid_metric_preview" });
      }
      for (const invalid of ["SELECT private_value", { ...action, sql: "SELECT private_value" },
        { ...action, parameters: { year: false } }]) {
        const res = await post("t", { ...payload, action: invalid });
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ ok: false, code: "invalid_requested_action" });
      }
    });

    it("does not simulate success when storage is unavailable or accept GET as a preview", async () => {
      const res = await post("t", payload, {}, { ...env, DB: { prepare() { throw new Error("private storage detail"); } } });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ ok: false, code: "control_storage_unavailable" });
      const get = await worker.fetch(new Request(origin + "/api/control/t/metric-previews", { headers: { Cookie: cookie } }),
        env, { waitUntil: () => undefined });
      expect(get.status).toBe(405);
      expect(get.headers.get("Allow")).toBe("POST");
    });
  });
});
