import { describe, expect, it } from "vitest";
import { mapInformationSchemaRowsToCatalog } from "../lib/schema-import";
import type { BigQueryQueryRow } from "../lib/bigquery";

const source = { projectId: "fixture-project", dataset: "fixture", tablePrefix: "ord", tableLimit: 2 };
const row: BigQueryQueryRow = { table_catalog: source.projectId, table_schema: source.dataset,
  table_name: "orders", table_type: "BASE TABLE", column_name: "id", data_type: "INT64",
  is_nullable: "NO", ordinal_position: "1", policy_tags: null };
const map = (rows: BigQueryQueryRow[], scope = source) => mapInformationSchemaRowsToCatalog(rows, "workspace", scope);

describe("schema import metadata admission", () => {
  it.each([
    ["project", { table_catalog: "another-project" }],
    ["dataset", { table_schema: "another_dataset" }],
    ["prefix", { table_name: "payments" }],
    ["missing name", { column_name: "" }],
    ["blank type", { data_type: " " }],
    ["unknown table type", { table_type: "TABLE" }],
    ["unknown nullability", { is_nullable: "unknown" }],
    ["numeric policy tags", { policy_tags: 0 }],
    ["boolean policy tags", { policy_tags: false }],
    ["blank policy tags", { policy_tags: " " }],
    ["zero position", { ordinal_position: 0 }],
    ["negative position", { ordinal_position: -1 }],
    ["fractional position", { ordinal_position: 1.5 }],
    ["boolean position", { ordinal_position: true }],
    ["empty position", { ordinal_position: "" }],
    ["noncanonical position", { ordinal_position: "01" }],
    ["unsafe position", { ordinal_position: "9007199254740992" }]
  ] satisfies Array<[string, BigQueryQueryRow]>)("rejects a bad %s without returning the preceding valid row", (_name, patch) => {
    expect(() => map([row, { ...row, column_name: "other", ordinal_position: "2", ...patch }]))
      .toThrow("Invalid BigQuery schema metadata.");
  });
  it.each(Object.keys(row))("requires explicit %s instead of silently defaulting it", key => {
    const invalid: BigQueryQueryRow = { ...row, column_name: "other", ordinal_position: "2" };
    delete invalid[key];
    expect(() => map([row, invalid])).toThrow("Invalid BigQuery schema metadata.");
  });
  it("rejects duplicate column names", () => {
    expect(() => map([row, { ...row, ordinal_position: "2" }])).toThrow("Invalid BigQuery schema metadata.");
  });
  it("rejects repeated numeric positions", () => {
    expect(() => map([row, { ...row, column_name: "other" }])).toThrow("Invalid BigQuery schema metadata.");
  });
  it("rejects contradictory table types", () => {
    expect(() => map([row, { ...row, column_name: "other", ordinal_position: "2", table_type: "VIEW" }]))
      .toThrow("Invalid BigQuery schema metadata.");
  });
  it("enforces the selected table count, not the number of columns", () => {
    const rows = [row, { ...row, table_name: "orders_archive" }];
    expect(() => map(rows, { ...source, tableLimit: 1 })).toThrow("Invalid BigQuery schema metadata.");
    expect(map(rows)).toHaveLength(2);
  });
  it("keeps valid empty results for the existing empty-import refusal", () => {
    expect(map([])).toEqual([]);
  });
  it("preserves explicit null pseudo-column positions and restrictive policy metadata", () => {
    const result = map([{ ...row, column_name: "_PARTITIONTIME", data_type: "TIMESTAMP", ordinal_position: null },
      { ...row, column_name: "_PARTITIONDATE", data_type: "DATE", ordinal_position: null }, row,
      { ...row, column_name: "contact", data_type: "STRING", ordinal_position: 2, is_nullable: "YES",
        policy_tags: "projects/fixture/locations/us/taxonomies/1/policyTags/2" }]);
    expect(result).toHaveLength(1);
    expect(result[0].fields).toHaveLength(4);
    expect(result[0].fields[0].description).toBe("Pseudo column from fixture.orders.");
    expect(result[0].fields[3]).toMatchObject({ name: "contact", pii: true, queryable: false, mode: "NULLABLE" });
  });
});
