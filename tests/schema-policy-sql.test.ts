import { afterEach, describe, expect, it, vi } from "vitest";
import { Parser } from "node-sql-parser/build/bigquery";
import { evaluateSchemaCatalog, evaluateSchemaPolicy } from "../lib/schema-policy";
import { analyzePreviewSql } from "../lib/preview-sql-policy";
import type { SchemaCatalogTable } from "../lib/admin-store";
import { onRequestPost } from "../functions/api/query/dry-run";
import * as auth from "../lib/auth-request";
import * as bigquery from "../lib/bigquery";

afterEach(() => vi.restoreAllMocks());

describe("schema policy SQL syntax boundaries", () => {
  it.each([
    "SELECT `customer_id` FROM `demo.orders`",
    "SELECT o.`customer_id` FROM `demo.orders` AS o",
    "SELECT customer_id AS customer_id FROM `demo.orders`",
    "SELECT order_id FROM `demo.orders` WHERE `customer_id` = 1",
    "SELECT `missing_column` FROM `demo.orders`",
    "SELECT COUNT(*) FROM `demo.orders`, `private.secrets`",
    "SELECT o.* EXCEPT(order_id) FROM `demo.orders` AS o"
  ])("does not allow hidden table or column references: %s", async sql => {
    const result = await evaluateSchemaPolicy({}, { sql, workspace: "demo" });
    expect(result.blocked).toBe(true);
    expect(result.reasons.length).toBeGreaterThan(0);
  });
});

describe("supported preview SQL profile", () => {
  it.each([
    "SELECT `order_id` FROM `demo.orders`",
    "SELECT o.`order_id` FROM `demo.orders` AS o",
    "SELECT order_id AS order_id FROM `demo.orders`",
    "SELECT COUNT(*) AS n FROM demo.orders",
    "SELECT COUNT(DISTINCT order_id) AS n FROM demo.orders",
    "SELECT EXTRACT(ISOWEEK FROM order_date) AS week FROM demo.orders",
    "SELECT CAST(order_id AS STRING), SAFE_CAST(order_id AS INT64) FROM demo.orders",
    "SELECT COALESCE(order_id, 0), IFNULL(order_id, 0), ABS(order_id) FROM demo.orders",
    "SELECT CASE WHEN order_id > 1 THEN order_id ELSE 0 END FROM demo.orders",
    "SELECT -order_id FROM demo.orders WHERE order_id BETWEEN 1 AND 9",
    "SELECT order_id AS customer_id FROM demo.orders GROUP BY customer_id HAVING customer_id > 0 ORDER BY customer_id DESC LIMIT 5",
    "SELECT 'customer_id FROM private.secrets' AS label FROM demo.orders -- customer_id",
    "SELECT /* customer_id FROM private.secrets */ order_id FROM demo.orders;"
  ])("allows a fully analyzed safe query: %s", async sql => {
    expect(analyzePreviewSql(sql)).not.toBeNull();
    expect((await evaluateSchemaPolicy({}, { sql, workspace: "demo" })).blocked).toBe(false);
  });

  it.each([
    "SELECT customer_id AS safe FROM demo.orders",
    "SELECT order_id AS customer_id FROM demo.orders WHERE customer_id = 1",
    "SELECT COUNT(customer_id) FROM demo.orders",
    "SELECT order_id FROM demo.orders GROUP BY customer_id",
    "SELECT order_id FROM demo.orders HAVING customer_id > 0",
    "SELECT order_id FROM demo.orders ORDER BY customer_id",
    "SELECT order_id AS customer_id FROM demo.orders GROUP BY order_id HAVING COUNT(customer_id) > 0",
    "SELECT order_id AS customer_id FROM demo.orders GROUP BY order_id ORDER BY COUNT(customer_id)",
    "SELECT * FROM demo.orders",
    "SELECT o.* FROM demo.orders AS o",
    "SELECT unknown_column AS safe FROM demo.orders"
  ])("checks source fields without treating all aliases as exclusions: %s", async sql => {
    const result = await evaluateSchemaPolicy({}, { sql, workspace: "demo" });
    expect(result.blocked).toBe(true);
    expect(result.reasons.join(" ")).not.toContain("outside the supported");
  });

  it.each([
    "SELECT 1", "not SQL", "SELECT order_id FROM demo.orders; SELECT 1",
    "UPDATE demo.orders SET customer_id = 1",
    "WITH x AS (SELECT customer_id FROM demo.orders) SELECT * FROM x",
    "SELECT (SELECT customer_id FROM demo.orders) FROM demo.orders",
    "SELECT order_id FROM demo.orders UNION ALL SELECT customer_id FROM demo.orders",
    "SELECT a.order_id FROM demo.orders a JOIN demo.orders b ON a.order_id=b.order_id",
    "SELECT * FROM UNNEST([1,2])",
    "SELECT ROW_NUMBER() OVER (ORDER BY customer_id) FROM demo.orders",
    "SELECT STRUCT(customer_id) FROM demo.orders",
    "SELECT o FROM demo.orders AS o",
    "SELECT wrong.order_id FROM demo.orders AS o",
    "SELECT o.record.customer_id FROM demo.orders AS o",
    "SELECT order_id[OFFSET(0)] FROM demo.orders",
    "SELECT COUNT(*) FROM `demo.orders*`",
    "SELECT COUNT(*) FROM demo.orders FOR SYSTEM_TIME AS OF TIMESTAMP('2026-01-01')",
    "SELECT external_function(order_id) FROM demo.orders",
    "SELECT demo.CURRENT_DATE() FROM demo.orders",
    "SELECT order_id AS duplicate, order_date AS duplicate FROM demo.orders",
    "SELECT * EXCEPT(customer_id) FROM demo.orders"
  ])("fails closed on unsupported syntax or identity: %s", async sql => {
    const result = await evaluateSchemaPolicy({}, { sql, workspace: "demo" });
    expect(result.blocked).toBe(true);
    expect(result.checks.every(check => check.status === "warn")).toBe(true);
  });

  it("checks PII inside EXTRACT, casts, arithmetic, and conditions, not only direct outputs", () => {
    const catalog: SchemaCatalogTable[] = [{ id: "t", workspace: "demo", name: "demo.events", description: "Fixture",
      rowCount: 1, updatedAt: "2026-01-01T00:00:00Z", fields: [{ id: "f", name: "private_date", type: "DATE",
        mode: "NULLABLE", description: "Fixture", pii: true, queryable: true, usedInExamples: false, updatedAt: "2026-01-01T00:00:00Z" }] }];
    for (const expression of ["EXTRACT(YEAR FROM private_date)", "CAST(private_date AS STRING)",
      "CASE WHEN private_date IS NULL THEN 1 ELSE 0 END", "private_date + 1"]) {
      const result = evaluateSchemaCatalog("SELECT " + expression + " FROM demo.events", "demo", catalog);
      expect(result.blocked).toBe(true);
      expect(result.reasons).toContain("demo.events.private_date is marked PII");
    }
    expect(evaluateSchemaCatalog("SELECT COUNT(*) FROM demo.events WHERE private_date IS NULL", "demo", catalog).blocked).toBe(false);
    catalog[0].fields[0].pii = false;
    expect(evaluateSchemaCatalog("SELECT * FROM demo.events", "demo", catalog).blocked).toBe(false);
  });

  it("bounds input, AST traversal and nesting, and refuses unknown parser shapes", () => {
    expect(analyzePreviewSql(" ".repeat(20_001))).toBeNull();
    expect(analyzePreviewSql("SELECT " + "ABS(".repeat(35) + "order_id" + ")".repeat(35) + " FROM demo.orders")).toBeNull();
    expect(analyzePreviewSql("SELECT " + Array.from({ length: 2100 }, () => "1").join(",") + " FROM demo.orders")).toBeNull();
    const parsed = new Parser().astify("SELECT order_id FROM demo.orders");
    const unexpected = Object.assign({}, parsed, { unreviewedClause: { type: "column_ref", column: "customer_id" } });
    vi.spyOn(Parser.prototype, "astify").mockReturnValue(unexpected);
    expect(analyzePreviewSql("SELECT order_id FROM demo.orders")).toBeNull();
  });
});

describe("preview API policy admission", () => {
  it.each([
    "SELECT `customer_id` FROM demo.orders", "SELECT customer_id AS customer_id FROM demo.orders",
    "SELECT COUNT(*) FROM `demo.orders`, `private.secrets`", "SELECT * EXCEPT(order_id) FROM demo.orders"
  ])("does not reach live transport for %s", async sql => {
    vi.spyOn(auth, "getSessionFromRequest").mockResolvedValue({ provider: "google", providerId: "fixture",
      name: "Fixture", email: "fixture@example.test", expiresAt: Date.now() + 60000 });
    const transport = vi.spyOn(bigquery, "runBigQueryDryRun");
    const outbound = vi.spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("Unexpected network"); });
    const result = await onRequestPost({ request: new Request("https://gateway.test/api/query/dry-run", { method: "POST",
      body: JSON.stringify({ sql, workspace: "demo" }) }), env: { GATEWAY_MODE: "demo", BIGQUERY_PROJECT_ID: "fixture-project",
      BIGQUERY_CLIENT_EMAIL: "fixture@example.test", BIGQUERY_PRIVATE_KEY: "synthetic-unused" } });
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ preview: { status: "blocked", scannedBytes: 0, error: { code: "schema_policy_blocked" } } });
    expect(transport).not.toHaveBeenCalled();
    expect(outbound).not.toHaveBeenCalled();
  });
});
