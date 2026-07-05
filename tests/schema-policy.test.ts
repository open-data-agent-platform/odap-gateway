import { describe, expect, it } from "vitest";
import type { SchemaCatalogTable } from "../lib/admin-store";
import {
  applySchemaPolicyToDryRunPreview,
  evaluateSchemaCatalog,
  evaluateSchemaPolicy
} from "../lib/schema-policy";
import { estimateDryRun } from "../lib/phase2";

describe("phase 4 schema policy enforcement", () => {
  it("allows bounded queries against queryable workspace fields", async () => {
    const evaluation = await evaluateSchemaPolicy(
      {},
      {
        workspace: "analytics",
        sql: "SELECT order_id FROM `analytics.orders` WHERE order_date >= CURRENT_DATE();"
      }
    );

    expect(evaluation.blocked).toBe(false);
    expect(
      evaluation.checks.find(
        (check) => check.label === "Workspace table allowlist"
      )
    ).toMatchObject({
      status: "pass"
    });
  });

  it("blocks seed PII fields that are not queryable", async () => {
    const evaluation = await evaluateSchemaPolicy(
      {},
      {
        workspace: "analytics",
        sql: "SELECT customer_id FROM `analytics.orders` WHERE order_date >= CURRENT_DATE();"
      }
    );

    expect(evaluation.blocked).toBe(true);
    expect(evaluation.reasons.join(" ")).toContain(
      "analytics.orders.customer_id"
    );
  });

  it("does not treat COUNT(*) as a selected PII star export", async () => {
    const evaluation = await evaluateSchemaPolicy(
      {},
      {
        workspace: "analytics",
        sql: "SELECT COUNT(*) AS order_count FROM `analytics.orders` WHERE order_date >= CURRENT_DATE();"
      }
    );

    expect(evaluation.blocked).toBe(false);
  });

  it("does not treat EXTRACT FROM expressions as table references", async () => {
    const evaluation = await evaluateSchemaPolicy(
      {},
      {
        workspace: "analytics",
        sql: "SELECT EXTRACT(ISOWEEK FROM order_date) AS week_num FROM `analytics.orders` WHERE order_date >= CURRENT_DATE();"
      }
    );

    expect(evaluation.blocked).toBe(false);
    expect(evaluation.referencedTables).toEqual(["analytics.orders"]);
  });

  it("blocks tables outside the selected workspace allowlist", () => {
    const evaluation = evaluateSchemaCatalog(
      "SELECT order_id FROM `analytics.orders` WHERE order_date >= CURRENT_DATE();",
      "marketing",
      createPolicyCatalog(),
      "d1"
    );

    expect(evaluation.blocked).toBe(true);
    expect(
      evaluation.checks.find(
        (check) => check.label === "Workspace table allowlist"
      )?.detail
    ).toContain("outside marketing allowlist");
  });

  it("turns blocked policy results into blocked dry-run previews", async () => {
    const sql =
      "SELECT customer_id FROM `analytics.orders` WHERE order_date >= CURRENT_DATE();";
    const evaluation = await evaluateSchemaPolicy(
      {},
      {
        workspace: "analytics",
        sql
      }
    );
    const preview = applySchemaPolicyToDryRunPreview(
      estimateDryRun(sql),
      evaluation
    );

    expect(preview.status).toBe("blocked");
    expect(preview.scannedBytes).toBe(0);
    expect(preview.error?.code).toBe("schema_policy_blocked");
  });
});

function createPolicyCatalog(): SchemaCatalogTable[] {
  return [
    {
      id: "table-analytics-orders",
      workspace: "analytics",
      name: "analytics.orders",
      description: "Orders",
      rowCount: 100,
      updatedAt: "2026-06-22T00:00:00.000Z",
      fields: [
        {
          id: "field-order-id",
          name: "order_id",
          type: "INT64",
          mode: "REQUIRED",
          description: "Order id",
          pii: false,
          queryable: true,
          usedInExamples: true,
          updatedAt: "2026-06-22T00:00:00.000Z"
        },
        {
          id: "field-customer-id",
          name: "customer_id",
          type: "INT64",
          mode: "NULLABLE",
          description: "Customer id",
          pii: true,
          queryable: false,
          usedInExamples: false,
          updatedAt: "2026-06-22T00:00:00.000Z"
        }
      ]
    }
  ];
}
