import { describe, expect, it } from "vitest";
import {
  generateBigQuerySql,
  optimizeBigQuerySql,
  validateBigQuerySql
} from "../lib/copilot-engine";

describe("copilot engine", () => {
  it("generates read-only BigQuery SQL with a bounded date filter", () => {
    const result = generateBigQuerySql("weekly revenue by acquisition channel");

    expect(result.sql).toContain("SELECT");
    expect(result.sql).toContain("DATE_SUB");
    expect(result.sql).not.toMatch(/\b(DELETE|UPDATE|DROP|TRUNCATE)\b/i);
  });

  it("warns when destructive SQL is pasted", () => {
    const checks = validateBigQuerySql("DROP TABLE demo.orders;");

    expect(checks[0]).toMatchObject({
      label: "No destructive operations",
      status: "warn"
    });
  });

  it("warns when selected columns are not in the known schema", () => {
    const checks = validateBigQuerySql(
      "SELECT order_id, made_up_metric FROM `demo.orders` WHERE order_date >= CURRENT_DATE();"
    );
    const schemaCheck = checks.find(
      (check) => check.label === "Schema-validated columns"
    );

    expect(schemaCheck).toMatchObject({
      status: "warn"
    });
    expect(schemaCheck?.detail).toContain("made_up_metric");
  });

  it("does not treat interval units as schema columns", () => {
    const checks = validateBigQuerySql(
      "SELECT order_id FROM `demo.orders` WHERE order_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 7 DAY);"
    );
    const schemaCheck = checks.find(
      (check) => check.label === "Schema-validated columns"
    );

    expect(schemaCheck).toMatchObject({
      status: "pass"
    });
  });

  it("warns when SQL selects likely PII fields", () => {
    const checks = validateBigQuerySql(
      "SELECT email, phone_number FROM `demo.customers` WHERE created_at >= CURRENT_TIMESTAMP();"
    );
    const piiCheck = checks.find(
      (check) => check.label === "No PII exposure risk"
    );

    expect(piiCheck).toMatchObject({
      status: "warn"
    });
    expect(piiCheck?.detail).toContain("email");
  });

  it("adds a cost guard when optimizing an unbounded query", () => {
    const result = optimizeBigQuerySql("SELECT * FROM `demo.orders`;");

    expect(result.sql).toContain("order_date >=");
    expect(result.sql).not.toContain("SELECT *");
  });
});
