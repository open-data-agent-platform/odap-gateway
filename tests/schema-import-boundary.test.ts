import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionCookie, signAuthPayload } from "../lib/auth";
import { runBigQueryQuery, type BigQueryEnv } from "../lib/bigquery";
import worker from "../worker";
import { adminAuthority } from "./fixtures/admin-authority";

const secret = "synthetic-import-test-session";
const tokenUrl = "https://oauth2.googleapis.com/token";
const queryUrl = "https://bigquery.googleapis.com/bigquery/v2/projects/fixture-project/queries";
const calls: string[] = [];
const prepare = vi.fn(() => { throw new Error("Unexpected catalog I/O"); });
let fixtureKey: string;
let warehouseBody: string | undefined;

// Intercept the token exchange and the actual query submission; an invalid key
// alone could make a broken production guard appear to block outbound traffic.
beforeAll(() => {
  fixtureKey = generateKeyPairSync("rsa",{modulusLength:2048}).privateKey.export({format:"pem",type:"pkcs8"}).toString();
});
beforeEach(() => {
  calls.length = 0;
  prepare.mockClear();
  warehouseBody = undefined;
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push(String(url));
    if (url === tokenUrl) return Response.json({access_token:"fixture-only"});
    if (url === queryUrl && init.method === "POST" && JSON.parse(String(init.body)).query.includes("INFORMATION_SCHEMA")) {
      if (warehouseBody !== undefined) return new Response(warehouseBody);
      return Response.json({error:{status:"fixture_query_intercepted",message:"Synthetic stop before catalog persistence."}},{status:400});
    }
    throw new Error("Unexpected outbound request");
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

async function post(mode: string | undefined, role: "admin" | "member" | null = "admin") {
  const cookie = role ? createSessionCookie(await signAuthPayload({provider:"google",providerId:"fixture",
    email:"fixture@example.test",name:"Fixture",role,expiresAt:Date.now()+60000},secret),true) : "";
  return worker.fetch(new Request("https://gateway.test/api/admin/schema-import?GATEWAY_MODE=demo",{
    method:"POST",headers:{Cookie:cookie,"X-Gateway-Mode":"demo"},body:JSON.stringify({
      projectId:"fixture-project",dataset:"fixture_dataset",workspace:"other_tenant",
      GATEWAY_MODE:"demo",contractId:"claimed-contract",reservationId:"claimed-reservation"
    })
  }),{AUTH_COOKIE_SECRET:secret,GATEWAY_MODE:mode as BigQueryEnv["GATEWAY_MODE"],
    BIGQUERY_PROJECT_ID:"fixture-project",BIGQUERY_CLIENT_EMAIL:"fixture@example.test",BIGQUERY_PRIVATE_KEY:fixtureKey,
    DB:{prepare:sql => sql.startsWith("SELECT role,email FROM users ")
      ? adminAuthority("google","fixture","fixture@example.test").prepare(sql) : prepare(),
      batch:async () => {throw new Error("Unexpected catalog transaction");}},
    ASSETS:{fetch:async () => {throw new Error("Unexpected asset request");}}
  },{waitUntil:() => undefined});
}

describe("legacy schema import warehouse boundary", () => {
  it.each(["production",undefined,"","Production","demo "])("denies a signed admin outside explicit demo mode (%s)",async mode => {
    const response = await post(mode);
    expect(calls).toEqual([]);
    expect(prepare).not.toHaveBeenCalled();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ok:false,code:"legacy_query_disabled"});
  });
  it("still reaches the intercepted metadata query in explicitly configured demo mode",async () => {
    const response = await post("demo");
    expect(calls).toEqual([tokenUrl,queryUrl]);
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toMatchObject({ok:false,code:"http_400",message:"BigQuery request failed (HTTP 400)."});
    expect(JSON.stringify(body)).not.toMatch(/fixture_query_intercepted|Synthetic stop before catalog persistence/);
    expect(prepare).not.toHaveBeenCalled();
  });
  it.each([[null,401],["member",403]] as const)("retains the HTTP admin gate for %s",async (role,status) => {
    const response = await post("demo",role);
    expect(response.status).toBe(status);
    expect(calls).toEqual([]);
    expect(prepare).not.toHaveBeenCalled();
  });
  it.each(["oversized", "non-object"])("does not persist a refused %s response", async kind => {
    warehouseBody = kind === "oversized" ? " ".repeat(256 * 1024) + JSON.stringify({ jobComplete: true,
      schema: { fields: [{ name: "table_name" }, { name: "column_name" }, { name: "data_type" }] },
      rows: [{ f: [{ v: "events" }, { v: "id" }, { v: "STRING" }] }], totalRows: "1" }) : "false";
    const response = await post("demo");
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ ok: false, code: "bigquery_query_failed", message: "BigQuery query failed." });
    expect(calls).toEqual([tokenUrl, queryUrl]);
    expect(prepare).not.toHaveBeenCalled();
  });
  it("guards direct legacy query callers before reading credential material",async () => {
    const result = await runBigQueryQuery("SELECT 1",{GATEWAY_MODE:"production",
      get BIGQUERY_PROJECT_ID(): string {throw new Error("Credentials inspected before mode");}});
    expect(result).toMatchObject({ok:false,code:"legacy_query_disabled"});
    expect(calls).toEqual([]);
  });
  it.each([
    ["missing completion", { jobComplete: undefined }, "bigquery_query_failed"],
    ["another page", { pageToken: "synthetic-private-token" }, "bigquery_query_incomplete"],
    ["missing row", { totalRows: "2" }, "bigquery_query_failed"],
    ["missing count", { totalRows: undefined }, "bigquery_query_failed"],
    ["missing cell", { rows: [{ f: [] }] }, "bigquery_query_failed"]
  ] as const)("refuses %s before catalog I/O", async (_name, patch, code) => {
    warehouseBody = JSON.stringify({ jobComplete: true, totalRows: "1", schema: { fields: [
      "table_catalog", "table_schema", "table_name", "table_type", "column_name", "data_type", "is_nullable", "ordinal_position", "policy_tags"
    ].map(name => ({ name })) }, rows: [{ f: [
      "fixture-project", "fixture_dataset", "orders", "BASE TABLE", "id", "INT64", "NO", "1", null
    ].map(v => ({ v })) }], ...patch });
    const response = await post("demo");
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ ok: false, code });
    expect(calls).toEqual([tokenUrl, queryUrl]);
    expect(prepare).not.toHaveBeenCalled();
  });
  it.each([
    ["project", { table_catalog: "synthetic-private-project" }],
    ["dataset", { table_schema: "synthetic_private_dataset" }],
    ["invalid row", { data_type: "" }],
    ["missing policy tag field", { policy_tags: undefined }],
    ["false policy tags", { policy_tags: false }],
    ["nullable flag", { is_nullable: "unknown" }],
    ["duplicate column", { column_name: "id" }]
  ])("refuses %s in complete metadata before catalog I/O", async (_name, patch) => {
    const good = { table_catalog: "fixture-project", table_schema: "fixture_dataset", table_name: "orders",
      table_type: "BASE TABLE", column_name: "id", data_type: "INT64", is_nullable: "NO", ordinal_position: "1", policy_tags: null };
    const bad = { ...good, column_name: "other", ordinal_position: "2", ...patch };
    const names = Object.keys(bad).filter(key => bad[key as keyof typeof bad] !== undefined);
    warehouseBody = JSON.stringify({ jobComplete: true, totalRows: "2", schema: { fields: names.map(name => ({ name })) },
      rows: [good, bad].map(row => ({ f: names.map(name => ({ v: row[name as keyof typeof row] })) })) });
    const response = await post("demo");
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false, code: "schema_import_metadata_invalid",
      message: "BigQuery schema metadata did not match the requested import." });
    expect(calls).toEqual([tokenUrl, queryUrl]);
    expect(prepare).not.toHaveBeenCalled();
  });
});
