import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { D1Database, D1PreparedStatement, D1Value } from "../lib/d1";
import { createSessionCookie, signAuthPayload } from "../lib/auth";
import { recordQueryDryRun } from "../lib/admin-store";
import type { BigQueryEnv } from "../lib/bigquery";
import { estimateDryRun } from "../lib/phase2";
import worker from "../worker";

const sql = "SELECT order_id FROM `demo.orders` WHERE order_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 7 DAY);";
const secret = "synthetic-history-preflight-session";
const tokenUrl = "https://oauth2.googleapis.com/token";
const jobUrl = "https://bigquery.googleapis.com/bigquery/v2/projects/fixture-project/jobs";
const calls: string[] = [];
let credentials: BigQueryEnv, cookie: string;

function storage(capability: unknown = "healthy") {
  const commands = new WeakMap<D1PreparedStatement,D1Value[]>();
  const run = vi.fn(async () => ({success:true}));
  const build = (query: string, params: D1Value[] = []): D1PreparedStatement => {
    const statement = {
      bind:(...values: D1Value[]) => build(query,values),run,first:async () => null,
      all:async <T>() => ({success:true,results:(query.includes("FROM schema_tables")
        ? [{id:"table",workspace:"demo",table_name:"demo.orders",description:"Local fixture",row_count:1,updated_at:"fixture"}]
        : query.includes("FROM schema_fields") ? ["order_id","order_date"].map(name => ({id:name,table_id:"table",field_name:name,
          field_type:name === "order_id" ? "INT64" : "DATE",mode:"REQUIRED",description:"Fixture",pii:0,queryable:1,used_in_examples:1,updated_at:"fixture"}))
        : []) as T[]})
    };
    commands.set(statement,params);
    return statement;
  };
  const prepare = vi.fn((query: string) => build(query));
  const batch = vi.fn(async (statements: D1PreparedStatement[]) => statements.map((statement,index) => ({
    success:true,results:[index === 3 ? {confirmed:1} : {id:commands.get(statement)![0]}]
  })));
  const db = {prepare,batch:capability === "healthy" ? batch : capability} as D1Database;
  return {db,prepare,run,batch};
}

function post(env: BigQueryEnv & {DB?: D1Database;ODAP_GATEWAY_DB?: D1Database}, signed = true,
  body = JSON.stringify({sql,workspace:"demo",queryType:"Local preview",persisted:false,GATEWAY_MODE:"demo"})) {
  const request = new Request("https://gateway.test/api/query/dry-run?persisted=false",{
    method:"POST",headers:{Cookie:signed ? cookie : "","X-Gateway-Mode":"demo"},body
  });
  return {request,response:worker.fetch(request,{...env,AUTH_COOKIE_SECRET:secret,
    ASSETS:{fetch:async () => {throw new Error("Unexpected assets");}}},{waitUntil:() => undefined})};
}

describe("dry-run history capability preflight",() => {
  beforeAll(async () => {
    credentials = {BIGQUERY_PROJECT_ID:"fixture-project",BIGQUERY_CLIENT_EMAIL:"fixture@example.test",
      BIGQUERY_PRIVATE_KEY:generateKeyPairSync("rsa",{modulusLength:2048}).privateKey.export({format:"pem",type:"pkcs8"}).toString()};
    cookie = createSessionCookie(await signAuthPayload({provider:"google",providerId:"fixture",role:"member",
      email:"fixture@example.test",name:"Fixture",expiresAt:Date.now()+600000},secret));
  });
  beforeEach(() => {
    calls.length = 0;
    vi.spyOn(console,"error").mockImplementation(() => {});
    vi.stubGlobal("fetch",async (url: string, init: RequestInit) => {
      calls.push(String(url));
      if (url === tokenUrl) return Response.json({access_token:"synthetic-token"});
      if (url !== jobUrl || init.method !== "POST") throw new Error("Unexpected request");
      const {configuration} = JSON.parse(String(init.body));
      expect(configuration.dryRun).toBe(true);
      expect(configuration.query.query).toBe(sql);
      return Response.json({statistics:{totalBytesProcessed:"8192"}});
    });
  });
  afterEach(() => {vi.restoreAllMocks();vi.unstubAllGlobals();});

  it("baseline: rejects missing transactions before catalog or provider work",async () => {
    const primary = storage(null);
    const {request,response} = post({...credentials,GATEWAY_MODE:"demo",DB:primary.db});
    const result = await response;
    expect(calls).toEqual([]);
    expect(primary.prepare).not.toHaveBeenCalled();
    expect(request.bodyUsed).toBe(false);
    expect(result.status).toBe(503);
    expect(await result.json()).toMatchObject({ok:false,code:"dry_run_history_transaction_unavailable"});
  });

  it("baseline: refuses a noncallable preferred batch without using the secondary binding",async () => {
    const primary = storage("not-callable"), secondary = storage();
    const {response} = post({...credentials,GATEWAY_MODE:"demo",ODAP_GATEWAY_DB:primary.db,DB:secondary.db});
    const result = await response;
    expect(result.status).toBe(503);
    expect(primary.prepare).not.toHaveBeenCalled();
    expect(secondary.prepare).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("baseline: refuses unavailable bound history before consuming malformed demo input",async () => {
    const primary = storage(null);
    const {request,response} = post({GATEWAY_MODE:"demo",DB:primary.db},false,"not-json");
    expect((await response).status).toBe(503);
    expect(request.bodyUsed).toBe(false);
    expect(primary.prepare).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it.each([undefined,null,false,true,{},"batch",0])("rejects noncallable batch %j at API and recorder boundaries",async capability => {
    const primary = storage(null);
    Object.assign(primary.db,{batch:capability});
    const secondary = storage();
    const {request,response} = post({DB:primary.db},false);
    const result = await response;
    expect(result.status).toBe(503);
    expect(await result.json()).toEqual({ok:false,code:"dry_run_history_transaction_unavailable",
      message:"Transactional storage is required for dry-run history."});
    expect(request.bodyUsed).toBe(false);
    await expect(recordQueryDryRun({ODAP_GATEWAY_DB:primary.db,DB:secondary.db},
      {sql,workspace:"demo",queryType:"Local preview",preview:estimateDryRun(sql)})).rejects.toThrow("Transactional storage");
    expect(primary.prepare).not.toHaveBeenCalled();
    expect(secondary.prepare).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it.each(["demo","production"] as const)("retains unauthenticated refusal before capability disclosure in %s",async mode => {
    const primary = storage(null), {request,response} = post({...credentials,GATEWAY_MODE:mode,DB:primary.db},false,"not-json");
    expect((await response).status).toBe(401);
    expect(request.bodyUsed).toBe(false);
    expect(primary.prepare).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("retains the production raw-SQL refusal even with unavailable transactions",async () => {
    const primary = storage(null), {response} = post({...credentials,GATEWAY_MODE:"production",DB:primary.db});
    const result = await response;
    expect(result.status).toBe(403);
    expect(await result.json()).toEqual({ok:false,code:"production_preview_scope_unbound"});
    expect(primary.prepare).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("retains transport configuration refusal before storage capability",async () => {
    const primary = storage(null), {response} = post({...credentials,DB:primary.db});
    const result = await response;
    expect(result.status).toBe(503);
    expect(await result.json()).toEqual({ok:false,code:"gateway_mode_required"});
    expect(primary.prepare).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it.each(["DB","ODAP_GATEWAY_DB"] as const)("keeps a callable %s path through preview and confirmed persistence",async binding => {
    const primary = storage(), secondary = storage(null);
    const env = binding === "DB" ? {DB:primary.db} : {ODAP_GATEWAY_DB:primary.db,DB:secondary.db};
    const {response} = post({...credentials,GATEWAY_MODE:"demo",...env});
    const result = await response;
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ok:true,persisted:true,storageBinding:binding,
      preview:{persisted:true,mode:"live",scannedBytes:8192}});
    expect(primary.batch).toHaveBeenCalledTimes(1);
    expect(secondary.prepare).not.toHaveBeenCalled();
    expect(calls).toEqual([tokenUrl,jobUrl]);
  });

  it("retains request validation when a transactional binding is available",async () => {
    const primary = storage(), {response} = post({DB:primary.db},false,"not-json");
    expect((await response).status).toBe(400);
    expect(primary.prepare).not.toHaveBeenCalled();
    expect(primary.batch).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("does not claim callable-but-failing persistence is healthy or retry it",async () => {
    const primary = storage();
    primary.batch.mockRejectedValue(new Error("Synthetic transaction failure"));
    const {response} = post({...credentials,GATEWAY_MODE:"demo",DB:primary.db});
    const result = await response;
    expect(result.status).toBe(500);
    expect(await result.json()).toMatchObject({ok:false,code:"internal_error"});
    expect(primary.batch).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([tokenUrl,jobUrl]);
  });

  it("retains unbound, explicitly unpersisted simulation",async () => {
    const {response} = post({},false);
    const result = await response;
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ok:true,persisted:false,preview:{persisted:false,mode:"simulated"}});
    expect(calls).toEqual([]);
  });
});
