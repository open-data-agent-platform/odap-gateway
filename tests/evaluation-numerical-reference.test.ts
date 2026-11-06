import { describe, expect, it } from "vitest";
import inputs from "../docs/evaluation/fixtures/numerical.v1.json";
import manifest from "../docs/evaluation/scenarios.v1.json";
import { jobSqlite } from "./fixtures/job-sqlite";

// SQL aliases specify units independently of the manifest. COUNT(*) also
// distinguishes an empty selection from a nonempty selection of null values.
const reference = {
  "NUM-01": { sql: `SELECT SUM(value ->> '$.toll_cents') AS cents, COUNT(*) AS matched FROM json_each(?)`, matched: 3 },
  "NUM-02": { sql: `SELECT COUNT(*) AS rows, COUNT(*) AS matched FROM json_each(?)
    WHERE (value ->> '$.signed') = ?`, matched: 3 },
  "NUM-03": { sql: `SELECT SUM(value ->> '$.weight_grams') AS grams, COUNT(*) AS matched,
    COUNT(*) FILTER (WHERE json_type(value, '$.weight_grams') = 'null') AS explicitNulls FROM json_each(?)`, matched: 3, explicitNulls: 1 },
  "NUM-04": { sql: `SELECT SUM(value ->> '$.pulses') AS pulses, COUNT(*) AS matched FROM json_each(?)
    WHERE (value ->> '$.partition_id') = ?`, matched: 0 },
  "NUM-05": { sql: `SELECT COUNT(*) AS rows, COUNT(*) AS matched FROM json_each(?)
    WHERE (value ->> '$.partition_id') = ?`, matched: 0 },
  "NUM-06": { sql: `SELECT SUM(value ->> '$.correction_cents') AS cents, COUNT(*) AS matched FROM json_each(?)`, matched: 3 },
  "NUM-07": { sql: `SELECT SUM(value ->> '$.transfer_cents') AS cents, COUNT(*) AS matched FROM json_each(?)`, matched: 3 },
  "NUM-08": { sql: `SELECT COUNT(*) AS rows, COUNT(*) AS matched,
    COUNT(*) FILTER (WHERE json_type(value, '$.reading') = 'null') AS explicitNulls FROM json_each(?)`, matched: 2, explicitNulls: 2 },
  "NUM-09": { sql: `SELECT SUM(value ->> '$.parts') AS parts, COUNT(*) AS matched FROM json_each(?)
    WHERE (value ->> '$.bin') = ?`, matched: 2 },
  "NUM-10": { sql: `SELECT COUNT(*) AS rows, COUNT(*) AS matched FROM json_each(?)
    WHERE (value ->> '$.route') = ? AND (value ->> '$.active') = ?`, matched: 2 },
  "NUM-11": { sql: `SELECT SUM(value ->> '$.kwh') AS kWh, COUNT(*) AS matched FROM json_each(?)
    WHERE (value ->> '$.period') = ?`, matched: 2 },
  "NUM-12": { sql: `SELECT SUM(value ->> '$.tickets') AS tickets, COUNT(*) AS matched,
    COUNT(DISTINCT value ->> '$.batch') AS batches FROM json_each(?)`, matched: 3, batches: 3 },
  "NUM-13": { sql: `SELECT SUM(value ->> '$.cents') AS cents, COUNT(*) AS matched,
    COUNT(*) FILTER (WHERE json_type(value, '$.cents') = 'null') AS explicitNulls FROM json_each(?)
    WHERE (value ->> '$.depot') = ?`, matched: 2, explicitNulls: 2 },
  "NUM-14": { sql: `SELECT COUNT(*) AS rows, COUNT(*) AS matched FROM json_each(?)
    WHERE (value ->> '$.classification') = ?`, matched: 2 },
  "NUM-15": { sql: `SELECT SUM(value ->> '$.bytes') AS bytes, COUNT(*) AS matched FROM json_each(?)`, matched: 2 },
  "NUM-16": { sql: `SELECT COUNT(*) AS rows, COUNT(*) AS matched FROM json_each(?)
    WHERE (value ->> '$.pass') = ?`, matched: 2 }
} satisfies Record<keyof typeof inputs, { sql: string; matched: number; explicitNulls?: number; batches?: number }>;

describe("numerical fixture references (SQLite only)", () => {
  const numerical = manifest.categories.find(group => group.category === "numerical")!;

  const ids = Object.keys(inputs) as (keyof typeof inputs)[];
  it("provides one fixture and one reference for every declared numerical case", () => {
    const declared = numerical.cases.map(c => c.id).sort();
    expect([...ids].sort()).toEqual(declared);
    expect(Object.keys(reference).sort()).toEqual(declared);
  });

  it.each(ids)("cross-checks %s against its predeclared answer and unit", async id => {
    const expected = numerical.cases.find(c => c.id === id)?.expected;
    if (!expected || !("unit" in expected) || expected.outcome !== "answer") throw new Error("Missing numerical oracle: " + id);
    const { rows, parameters } = inputs[id];
    const { sql, ...checks } = reference[id];
    const result = await jobSqlite(":memory:", "first", sql, [JSON.stringify(rows),
      ...parameters.map(p => typeof p === "boolean" ? Number(p) : p)]);
    expect(result).toEqual({ [expected.unit]: expected.value, ...checks });
  });

  it("selects a populated meter partition when only the filter changes", async () => {
    const result = await jobSqlite(":memory:", "first", reference["NUM-04"].sql,
      [JSON.stringify(inputs["NUM-04"].rows), "north"]);
    expect(result).toEqual({ pulses: 21, matched: 1 });
  });
});
