import { describe, expect, it } from "vitest";
import {
  buildInformationSchemaQuery,
  mapInformationSchemaRowsToCatalog
} from "../lib/schema-import";

describe("schema import mapping", () => {
  it("builds a bounded INFORMATION_SCHEMA query", () => {
    const sql = buildInformationSchemaQuery({
      projectId: "demo-project",
      dataset: "analytics",
      tablePrefix: "order_",
      tableLimit: 25
    });

    expect(sql).toContain("`demo-project.analytics.INFORMATION_SCHEMA.TABLES`");
    expect(sql).toContain("`demo-project.analytics.INFORMATION_SCHEMA.COLUMNS`");
    expect(sql).toContain("STARTS_WITH(table_name, 'order_')");
    expect(sql).toContain("LIMIT 25");
  });

  it("maps INFORMATION_SCHEMA columns into catalog tables", () => {
    const catalog = mapInformationSchemaRowsToCatalog(
      [
        {
          table_catalog: "demo-project",
          table_schema: "analytics",
          table_name: "orders",
          table_type: "BASE TABLE",
          column_name: "order_id",
          data_type: "INT64",
          is_nullable: "NO",
          ordinal_position: "1",
          policy_tags: ""
        },
        {
          table_catalog: "demo-project",
          table_schema: "analytics",
          table_name: "orders",
          table_type: "BASE TABLE",
          column_name: "customer_email",
          data_type: "STRING",
          is_nullable: "YES",
          ordinal_position: "2",
          policy_tags: "projects/demo/locations/us/taxonomies/1/policyTags/2"
        }
      ],
      "analytics"
    );

    expect(catalog).toHaveLength(1);
    expect(catalog[0]).toMatchObject({
      workspace: "analytics",
      name: "analytics.orders"
    });
    expect(catalog[0].fields[0]).toMatchObject({
      name: "order_id",
      mode: "REQUIRED"
    });
    expect(catalog[0].fields[1]).toMatchObject({
      name: "customer_email",
      pii: true,
      queryable: false
    });
  });
});
