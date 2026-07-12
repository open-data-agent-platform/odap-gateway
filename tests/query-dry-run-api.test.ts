import { afterEach, describe, expect, it, vi } from "vitest";
import { onRequestPost } from "../functions/api/query/dry-run";

const boundedSql =
  "SELECT order_id FROM `demo.orders` WHERE order_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 7 DAY);";

describe("query dry-run API", () => {
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
        BIGQUERY_PRIVATE_KEY: "not-used-for-policy-blocked-query"
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
