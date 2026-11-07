import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../worker";
import { gatewayPath, internalGatewayPath, normalizeGatewayBasePath } from "../lib/gateway-path";
import { loadDocsFeedback } from "../lib/docs-feedback-client";
import { submitValidation, type Inspection } from "../lib/review-inspection";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("Gateway path mount", () => {
  it.each(["/", "gateway", "//gateway", "/gateway/", "/../gateway", "/gate%77ay", "/gateway?x=1", "/gateway*", "/gate\\way"])(
    "rejects invalid mount %s", value => expect(() => normalizeGatewayBasePath(value)).toThrow());

  it("keeps root hosting compatible and only matches complete mount segments", () => {
    expect(gatewayPath("/api/health", "")).toBe("/api/health");
    expect(gatewayPath("/", "/gateway")).toBe("/gateway");
    expect(gatewayPath("/api/health?x=1", "/gateway")).toBe("/gateway/api/health?x=1");
    expect(internalGatewayPath("/gateway", "/gateway")).toBe("/");
    expect(internalGatewayPath("/gateway/", "/gateway")).toBe("/");
    expect(internalGatewayPath("/gateway/admin", "/gateway")).toBe("/admin");
    expect(internalGatewayPath("/gateway-other/admin", "/gateway")).toBeNull();
    expect(internalGatewayPath("/gate%77ay/admin", "/gateway")).toBeNull();
  });

  const fetchAsset = vi.fn(async () => new Response("public asset"));
  const env = { GATEWAY_BASE_PATH: "/gateway", GATEWAY_MODE: "production" as const, ASSETS: { fetch: fetchAsset } };
  const call = (path: string, init?: RequestInit) => worker.fetch(new Request("https://site.test" + path, init), env,
    { waitUntil: () => undefined });

  it("routes mounted APIs and preserves POST methods and private cache boundaries", async () => {
    const health = await call("/gateway/api/health");
    expect(await health.json()).toEqual({ ok: true, service: "odap-gateway" });
    const refused = await call("/gateway/api/query/dry-run", { method: "POST", body: "{}" });
    expect(refused.status).toBe(401);
    expect(await refused.json()).toMatchObject({ code: "unauthenticated" });
    const session = await call("/gateway/api/auth/session");
    expect(session.headers.get("Cache-Control")).toContain("no-store");
    expect(await session.json()).toMatchObject({ authenticated: false, configured: false });
  });

  it.each(["/gateway/api/auth/start/google", "/gateway/api/auth/callback/google", "/gateway/admin.txt"])(
    "keeps local redirects under the mount: %s", async path => {
      const response = await call(path);
      expect(response.status).toBe(302);
      const destination = new URL(response.headers.get("Location")!);
      expect(destination.origin).toBe("https://site.test");
      expect(destination.pathname).toBe("/gateway/login");
    });

  it("keeps the logout POST redirect under the mount", async () => {
    const response = await call("/gateway/api/auth/logout", { method: "POST", headers: { Origin: "https://site.test" } });
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("https://site.test/gateway/login?logout=1");
  });

  it("remounts static asset canonical redirects without dropping query parameters", async () => {
    const response = await worker.fetch(new Request("https://site.test/gateway/docs.html?x=1"),
      { ...env, ASSETS: { fetch: async request => {
        expect(new URL(request.url).pathname).toBe("/docs.html");
        return Response.redirect("https://site.test/docs?x=1", 307);
      } } }, { waitUntil: () => undefined });
    expect(response.headers.get("Location")).toBe("https://site.test/gateway/docs?x=1");
  });

  it("prefixes browser API requests at build-time configuration", async () => {
    vi.stubEnv("NEXT_PUBLIC_GATEWAY_BASE_PATH", "/gateway");
    const send = vi.fn<typeof fetch>(async () => Response.json({ ok: true, feedback: [], persisted: true }));
    await loadDocsFeedback(new AbortController().signal, send);
    expect(send.mock.calls[0][0]).toBe("/gateway/api/docs/feedback");
  });

  it.each(["/gateway", ""])("requires mounted write acknowledgments, received prefix=%s", async prefix => {
    vi.stubEnv("NEXT_PUBLIC_GATEWAY_BASE_PATH", "/gateway");
    const inspected: Inspection = { tenantId: "tenant-a", revisionId: "rev-a", metricId: "metric-a",
      sourceRevision: "source-a", state: "candidate", definitionDigest: "digest", definitionJson: "{}",
      canRecordValidation: true, canRequestPromotion: false, canWithdrawApproval: false, canRetireRelease: false };
    const send = vi.fn<typeof fetch>(async () => Response.json({ ok: true,
      validation: { revisionId: "rev-a", definitionDigest: "digest" } }, { status: 201,
      headers: { Location: prefix + "/api/control/tenant-a/review/rev-a" } }));
    expect(await submitValidation(inspected, "evidence", new AbortController().signal, send))
      .toBe(prefix ? "recorded" : "unknown");
    expect(send.mock.calls[0][0]).toBe("/gateway/api/control/tenant-a/validations");
    expect(send).toHaveBeenCalledOnce();
  });

  it("passes wildcard sibling paths unchanged only on the configured site origin", async () => {
    const upstream = new Response("existing main site", { headers: { "X-Site": "unchanged" } });
    const send = vi.fn<typeof fetch>(async () => upstream);
    vi.stubGlobal("fetch", send);
    const request = new Request("https://site.test/gateway-other?x=1", { method: "POST", body: "original" });
    const response = await worker.fetch(request, { ...env, GATEWAY_SITE_ORIGIN: "https://site.test" },
      { waitUntil: () => undefined });
    expect(response).toBe(upstream);
    expect(response.headers.get("x-content-type-options")).toBeNull();
    expect(send.mock.calls[0][0]).toBe(request);
    expect(await request.text()).toBe("original");
    expect((await call("/gateway-other")).status).toBe(404);
    expect(send).toHaveBeenCalledOnce();
  });
});
