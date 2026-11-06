import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionCookie, SESSION_COOKIE, signAuthPayload } from "../lib/auth";
import { runBigQueryDryRun, type BigQueryEnv } from "../lib/bigquery";
import worker from "../worker";

const sql = "SELECT order_id FROM `demo.orders` WHERE order_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 7 DAY);";
const tokenUrl = "https://oauth2.googleapis.com/token";
const jobUrl = "https://bigquery.googleapis.com/bigquery/v2/projects/fixture-project/jobs";
const secret = "synthetic-preview-session";
const calls: string[] = [];
let credentials: BigQueryEnv;
let cookie: string;

beforeAll(async () => {
  credentials = { BIGQUERY_PROJECT_ID:"fixture-project", BIGQUERY_CLIENT_EMAIL:"fixture@example.test",
    BIGQUERY_PRIVATE_KEY:generateKeyPairSync("rsa",{modulusLength:2048}).privateKey.export({format:"pem",type:"pkcs8"}).toString() };
  cookie = createSessionCookie(await signAuthPayload({provider:"google",providerId:"fixture",role:"member",
    email:"fixture@example.test",name:"Fixture",expiresAt:Date.now()+600000},secret),true);
});
beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push(String(url));
    if (url === tokenUrl) return Response.json({access_token:"fixture-only"});
    if (url !== jobUrl || init.method !== "POST") throw new Error("Unexpected request");
    const {configuration} = JSON.parse(String(init.body));
    if (configuration.dryRun !== true || configuration.query.query !== sql) throw new Error("Expected a dry run only");
    return Response.json({statistics:{totalBytesProcessed:"8192"}});
  });
});
afterEach(() => vi.unstubAllGlobals());

function post(env: BigQueryEnv, session = "", body = JSON.stringify({sql,workspace:"demo",GATEWAY_MODE:"demo",dryRun:false})) {
  return worker.fetch(new Request("https://gateway.test/api/query/dry-run?GATEWAY_MODE=demo", {
    method:"POST",headers:{Cookie:session,"X-Gateway-Mode":"demo","X-Principal-Id":"fixture"},body
  }),{...env,AUTH_COOKIE_SECRET:secret,ASSETS:{fetch:async () => {throw new Error("Unexpected asset request");}}},
  {waitUntil:() => undefined});
}

describe("legacy live dry-run access", () => {
  it.each([false,true])("does not infer live gateway mode from credentials (signed: %s)",async signed => {
    const res = await post({...credentials,BIGQUERY_DRY_RUN_MODE:"live"},signed ? cookie : "");
    expect(calls).toEqual([]);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ok:false,code:"gateway_mode_required"});
  });
  it.each([["","invalid_gateway_mode"],["demo ","invalid_gateway_mode"]])("rejects invalid server mode %j",async (mode,code) => {
    const res = await post({...credentials,GATEWAY_MODE:mode as BigQueryEnv["GATEWAY_MODE"]},cookie);
    expect(calls).toEqual([]);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ok:false,code});
  });
  it("does not turn a misspelled dry-run setting into live access",async () => {
    const res = await post({...credentials,GATEWAY_MODE:"demo",BIGQUERY_DRY_RUN_MODE:"simulated " as "simulated"},cookie);
    expect(calls).toEqual([]);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ok:false,code:"invalid_dry_run_mode"});
  });
  it.each(["demo","production"] as const)("rejects missing and forged sessions before parsing SQL in live %s",async mode => {
    const oauthState = createSessionCookie(await signAuthPayload({provider:"google",nonce:"fixture",
      returnTo:"/",expiresAt:Date.now()+60000},secret),true);
    for (const session of ["",SESSION_COOKIE+"=invalid",oauthState]) {
      const res = await post({...credentials,GATEWAY_MODE:mode},session,"malformed");
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ok:false,code:"unauthenticated"});
      expect(calls).toEqual([]);
    }
  });
  it("allows an authenticated explicit demo to request only a dry-run job",async () => {
    const res = await post({...credentials,GATEWAY_MODE:"demo"},cookie);
    expect(await res.json()).toMatchObject({ok:true,preview:{mode:"live",scannedBytes:8192},persisted:false});
    expect(calls).toEqual([tokenUrl,jobUrl]);
  });
  it("does not downgrade signed production to demo when storage is absent or simulation is forced",async () => {
    for (const preview of ["live","simulated"] as const) {
      const res = await post({...credentials,GATEWAY_MODE:"production",BIGQUERY_DRY_RUN_MODE:preview},cookie);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ok:false,code:"production_not_configured"});
      expect(calls).toEqual([]);
    }
  });
  it("retains anonymous, clearly labeled simulations without a warehouse call",async () => {
    for (const env of [{},{...credentials,BIGQUERY_DRY_RUN_MODE:"simulated" as const}]) {
      const res = await post(env);
      expect(await res.json()).toMatchObject({ok:true,preview:{mode:"simulated"},persisted:false});
      expect(calls).toEqual([]);
    }
  });
  it("also rejects implicit live mode at the transport boundary",async () => {
    const preview = await runBigQueryDryRun(sql,credentials);
    expect(calls).toEqual([]);
    expect(preview).toMatchObject({status:"blocked",error:{code:"gateway_mode_required"}});
  });
});
