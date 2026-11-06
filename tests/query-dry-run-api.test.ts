import { afterEach, describe, expect, it, vi } from "vitest";
import { onRequestPost } from "../functions/api/query/dry-run";
import * as authRequest from "../lib/auth-request";

const boundedSql =
  "SELECT order_id FROM `demo.orders` WHERE order_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 7 DAY);";

describe("query dry-run API", () => {
  it("refuses demo fallback for an authenticated production request without configuration", async () => {
    vi.spyOn(authRequest, "getSessionFromRequest").mockResolvedValue({ provider: "google", providerId: "demo",
      email: "demo@example.test", name: "Demo", role: "member", expiresAt: Date.now() + 60_000 });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const response = await onRequestPost({ request: new Request("https://odap-gateway.local/api/query/dry-run", {
      method: "POST", body: JSON.stringify({ sql: boundedSql })
    }), env: { GATEWAY_MODE: "production" } });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "production_not_configured" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it("denies production requests before reading SQL or calling the warehouse without a session", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const response = await onRequestPost({ request: new Request("https://odap-gateway.local/api/query/dry-run", {
      method: "POST", body: "not-json"
    }), env: { GATEWAY_MODE: "production" } });
    expect(response.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns simulated dry-run data when BigQuery is not configured", async () => {
    const response = await onRequestPost({
      request: new Request("https://odap-gateway.local/api/query/dry-run", {
        method: "POST",
        body: JSON.stringify({
          sql: boundedSql,
          workspace: "demo",
          queryType: "Revenue rollup"
        })
      }),
      env: {}
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      persisted: boolean;
      preview: {
        mode: string;
        configured: boolean;
        error?: {
          code: string;
        };
      };
    };

    expect(body.ok).toBe(true);
    expect(body.persisted).toBe(false);
    expect(body.preview.mode).toBe("simulated");
    expect(body.preview.configured).toBe(false);
    expect(body.preview.error?.code).toBe("bigquery_not_configured");
  });

  it("blocks schema policy violations before BigQuery dry-run", async () => {
    vi.spyOn(authRequest, "getSessionFromRequest").mockResolvedValue({provider:"google",providerId:"fixture",
      name:"Fixture",email:"fixture@example.test",expiresAt:Date.now()+60000});
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const response = await onRequestPost({
      request: new Request("https://odap-gateway.local/api/query/dry-run", {
        method: "POST",
        body: JSON.stringify({
          sql: "SELECT customer_id FROM `demo.orders` WHERE order_date >= CURRENT_DATE();",
          workspace: "demo",
          queryType: "Customer identifier export"
        })
      }),
      env: {
        BIGQUERY_PROJECT_ID: "demo-project",
        BIGQUERY_CLIENT_EMAIL: "svc@example.iam.gserviceaccount.com",
        BIGQUERY_PRIVATE_KEY: "not-used-for-policy-blocked-query",
        GATEWAY_MODE: "demo"
      }
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      preview: {
        status: string;
        error?: {
          code: string;
        };
        checks: Array<{
          label: string;
          status: string;
          detail: string;
        }>;
      };
    };

    expect(body.preview.status).toBe("blocked");
    expect(body.preview.error?.code).toBe("schema_policy_blocked");
    expect(
      body.preview.checks.find(
        (check) => check.label === "Schema-validated columns"
      )?.detail
    ).toContain("non-queryable");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects empty SQL", async () => {
    const response = await onRequestPost({
      request: new Request("https://odap-gateway.local/api/query/dry-run", {
        method: "POST",
        body: JSON.stringify({
          sql: " "
        })
      }),
      env: {}
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "sql_required"
    });
  });
});
