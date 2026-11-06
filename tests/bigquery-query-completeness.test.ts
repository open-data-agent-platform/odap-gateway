import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { runBigQueryQuery } from "../lib/bigquery";

const env = { GATEWAY_MODE: "demo" as const, BIGQUERY_PROJECT_ID: "fixture-project",
  BIGQUERY_CLIENT_EMAIL: "fixture@example.test", BIGQUERY_PRIVATE_KEY: "" };
const complete = { jobComplete: true, totalRows: "1", schema: { fields: [{ name: "n" }] }, rows: [{ f: [{ v: "17" }] }] };
beforeAll(() => {
  env.BIGQUERY_PRIVATE_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey
    .export({ format: "pem", type: "pkcs8" }).toString();
});
afterEach(() => { vi.restoreAllMocks(); });

async function run(payload: unknown) {
  const http = vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json({ access_token: "synthetic-token" }))
    .mockResolvedValueOnce(Response.json(payload))
    .mockRejectedValue(new Error("Unexpected retry or pagination"));
  const result = await runBigQueryQuery("SELECT 17 AS n", env);
  expect(http).toHaveBeenCalledTimes(2);
  expect(String(http.mock.calls[1][0])).toBe("https://bigquery.googleapis.com/bigquery/v2/projects/fixture-project/queries");
  return result;
}

describe("legacy query completeness", () => {
  it.each([undefined, null, "true", 1])("rejects non-boolean completion %j", async jobComplete => {
    expect(await run({ ...complete, jobComplete })).toMatchObject({ ok: false, code: "bigquery_query_failed" });
  });
  it("retains the explicit unfinished-job refusal", async () => {
    expect(await run({ ...complete, jobComplete: false })).toMatchObject({ ok: false, code: "bigquery_query_incomplete" });
  });
  it("rejects another page even when the row count otherwise agrees", async () => {
    expect(await run({ ...complete, pageToken: "synthetic-private-page-token" })).toEqual({ ok: false,
      code: "bigquery_query_incomplete", message: "BigQuery schema import requires a complete single-page result." });
  });
  it.each([null, false, 0, {}, []].map(pageToken => ({ pageToken })))("rejects malformed page token $pageToken", async ({ pageToken }) => {
    expect(await run({ ...complete, pageToken })).toMatchObject({ ok: false, code: "bigquery_query_failed" });
  });
  it.each([undefined, null, 1, "", " ", "01", "+1", "1.0", "1e0", "-1", "NaN", "9007199254740992", "0", "2"])(
    "rejects invalid or mismatched totalRows %j", async totalRows => {
      expect(await run({ ...complete, totalRows })).toEqual({ ok: false, code: "bigquery_query_failed", message: "BigQuery query failed." });
    });
  it.each([null, {}, "rows", 1])("rejects a non-array rows value %j", async rows => {
    expect(await run({ ...complete, rows })).toMatchObject({ ok: false, code: "bigquery_query_failed" });
  });
  it("does not infer an empty successful result from an empty object", async () => {
    expect(await run({})).toMatchObject({ ok: false, code: "bigquery_query_failed" });
  });
  it.each([undefined, []].map(rows => ({ rows })))("accepts a confirmed zero-row result with rows $rows", async ({ rows }) => {
    expect(await run({ jobComplete: true, totalRows: "0", rows })).toMatchObject({ ok: true, totalRows: 0, rows: [] });
  });
  it.each([undefined, ""])("accepts a complete single page with token %j", async pageToken => {
    expect(await run({ ...complete, pageToken })).toMatchObject({ ok: true, totalRows: 1, rows: [{ n: "17" }] });
  });
  it.each([
    [undefined, complete.rows],
    [{ fields: [] }, complete.rows],
    [{ fields: [{ name: "" }] }, complete.rows],
    [{ fields: [null] }, complete.rows],
    [{ fields: [{ name: "n" }, { name: "n" }] }, [{ f: [{ v: "1" }, { v: "2" }] }]],
    [complete.schema, [null]],
    [complete.schema, [{}]],
    [complete.schema, [{ f: [] }]],
    [complete.schema, [{ f: [{ v: "17" }, { v: "18" }] }]],
    [complete.schema, [{ f: [{}] }]],
    [complete.schema, [{ f: [null] }]]
  ])("rejects lossy row mapping for schema %j and rows %j", async (schema, rows) => {
    expect(await run({ ...complete, schema, rows })).toMatchObject({ ok: false, code: "bigquery_query_failed" });
  });
  it("preserves every named cell including null, false and prototype-like names", async () => {
    const result = await run({ ...complete, schema: { fields: ["n", "flag", "__proto__"].map(name => ({ name })) },
      rows: [{ f: [{ v: null }, { v: false }, { v: "ordinary cell" }] }] });
    expect(result).toMatchObject({ ok: true, totalRows: 1, rows: [{ n: null, flag: false }] });
    if (result.ok) expect(Object.getOwnPropertyDescriptor(result.rows[0], "__proto__")?.value).toBe("ordinary cell");
  });
});
