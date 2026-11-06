import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { D1Database, D1PreparedStatement, D1Value } from "../lib/d1";
import { createSessionCookie, signAuthPayload } from "../lib/auth";
import { importBigQuerySchemaCatalog } from "../lib/schema-import";
import type { BigQueryEnv } from "../lib/bigquery";
import { adminAuthority } from "./fixtures/admin-authority";
import worker from "../worker";

const secret = "synthetic-import-preflight-session";
const tokenUrl = "https://oauth2.googleapis.com/token";
const queryUrl = "https://bigquery.googleapis.com/bigquery/v2/projects/fixture-project/queries";
const input = {workspace:"fixture",dataset:"fixture",projectId:"fixture-project"};
const actor = {provider:"google" as const,providerId:"fixture",email:"fixture@example.test"};
const calls: string[] = [];
let credentials: BigQueryEnv, cookie: string, memberCookie: string;
const metadata = {jobComplete:true,totalRows:"1",schema:{fields:[
  "table_catalog","table_schema","table_name","table_type","column_name","data_type","is_nullable","ordinal_position","policy_tags"
].map(name => ({name,type:"STRING"}))},rows:[{f:[
  "fixture-project","fixture","orders","BASE TABLE","contact","STRING","YES","1",null
].map(v => ({v}))}]};

function storage(capability: unknown = "healthy") {
  const authority = adminAuthority("google","fixture","fixture@example.test");
  const commands = new WeakMap<D1PreparedStatement,{query:string;params:D1Value[]}>();
  const run = vi.fn(async () => ({success:true}));
  const catalogPrepare = vi.fn();
  const build = (query: string, params: D1Value[] = []): D1PreparedStatement => {
    const statement: D1PreparedStatement = {
      bind:(...values) => build(query,values),run,
      first:async () => null,all:async () => ({success:true,results:[]})
    };
    commands.set(statement,{query,params});
    return statement;
  };
  const prepare = vi.fn((query: string) => {
    if (query === "SELECT role,email FROM users WHERE id=? AND provider=? AND provider_id=?") return authority.prepare(query);
    catalogPrepare(query);
    return build(query);
  });
  const batch = vi.fn(async (statements: D1PreparedStatement[]) => statements.map(statement => {
    const {query,params} = commands.get(statement)!;
    const row = query.startsWith("SELECT CASE") ? {confirmed:1} : query.includes("INSERT INTO schema_fields")
      ? {id:params[0],table_id:params[1],field_name:params[2]} : {id:params[0]};
    return {success:true,results:[row]};
  }));
  return {db:{prepare,batch:capability === "healthy" ? batch : capability} as D1Database,
    prepare,catalogPrepare,run,batch};
}

function post(env: BigQueryEnv & {DB?:D1Database;ODAP_GATEWAY_DB?:D1Database},
  signed = cookie, body = JSON.stringify({...input,GATEWAY_MODE:"demo"})) {
  return worker.fetch(new Request("https://gateway.test/api/admin/schema-import?GATEWAY_MODE=demo",{
    method:"POST",headers:{Cookie:signed,"X-Gateway-Mode":"demo"},body
  }),{...env,AUTH_COOKIE_SECRET:secret,ASSETS:{fetch:async () => {throw new Error("Unexpected assets");}}},
  {waitUntil:() => undefined});
}

describe("schema import transaction capability preflight",() => {
  beforeAll(async () => {
    credentials = {BIGQUERY_PROJECT_ID:"fixture-project",BIGQUERY_CLIENT_EMAIL:"fixture@example.test",
      BIGQUERY_PRIVATE_KEY:generateKeyPairSync("rsa",{modulusLength:2048}).privateKey.export({format:"pem",type:"pkcs8"}).toString()};
    const session = {provider:"google" as const,providerId:"fixture",email:"fixture@example.test",name:"Fixture",expiresAt:Date.now()+600000};
    cookie = createSessionCookie(await signAuthPayload({...session,role:"admin"},secret));
    memberCookie = createSessionCookie(await signAuthPayload({...session,role:"member"},secret));
  });
  beforeEach(() => {
    calls.length = 0;
    vi.spyOn(console,"error").mockImplementation(() => {});
    vi.stubGlobal("fetch",vi.fn(async (url: string, init: RequestInit) => {
      calls.push(String(url));
      if (url === tokenUrl) return Response.json({access_token:"synthetic-token"});
      if (url !== queryUrl || init.method !== "POST") throw new Error("Unexpected request");
      expect(JSON.parse(String(init.body)).query).toContain("INFORMATION_SCHEMA");
      return Response.json(metadata);
    }));
  });
  afterEach(() => {vi.restoreAllMocks();vi.unstubAllGlobals();});

  it("baseline: refuses unavailable transactions before direct-wrapper provider work",async () => {
    const primary = storage(null);
    const result = await importBigQuerySchemaCatalog({...credentials,GATEWAY_MODE:"demo",DB:primary.db},input,actor);
    expect(calls).toEqual([]);
    expect(result).toMatchObject({ok:false,status:503,code:"schema_import_transaction_unavailable"});
    expect(primary.prepare).not.toHaveBeenCalled();
  });

  it("baseline: rejects a noncallable preferred binding before Worker provider work",async () => {
    const primary = storage("not-callable"), secondary = storage();
    const response = await post({...credentials,GATEWAY_MODE:"demo",ODAP_GATEWAY_DB:primary.db,DB:secondary.db});
    expect(calls).toEqual([]);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ok:false,code:"schema_import_transaction_unavailable"});
    expect(primary.prepare).toHaveBeenCalledTimes(1);
    expect(primary.catalogPrepare).not.toHaveBeenCalled();
    expect(secondary.prepare).not.toHaveBeenCalled();
  });

  it("baseline: rejects missing transactions without inspecting provider credential material",async () => {
    const primary = storage(null);
    const result = await importBigQuerySchemaCatalog({GATEWAY_MODE:"demo",DB:primary.db,
      BIGQUERY_PROJECT_ID:"fixture-project",BIGQUERY_CLIENT_EMAIL:"fixture@example.test",
      get BIGQUERY_PRIVATE_KEY(): string {throw new Error("Credential inspected before storage capability");}
    },input,actor);
    expect(result).toMatchObject({ok:false,status:503,code:"schema_import_transaction_unavailable"});
    expect(primary.prepare).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it.each([undefined,null,false,true,{},"batch",0])("refuses noncallable batch %j at direct and Worker boundaries",async capability => {
    const primary = storage(null), secondary = storage();
    Object.assign(primary.db,{batch:capability});
    const env = {...credentials,GATEWAY_MODE:"demo" as const,ODAP_GATEWAY_DB:primary.db,DB:secondary.db};
    expect(await importBigQuerySchemaCatalog(env,input,actor))
      .toMatchObject({ok:false,status:503,code:"schema_import_transaction_unavailable"});
    expect(primary.prepare).not.toHaveBeenCalled();
    const response = await post(env);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ok:false,code:"schema_import_transaction_unavailable",
      message:"Transactional storage is required for schema imports."});
    expect(primary.catalogPrepare).not.toHaveBeenCalled();
    expect(secondary.prepare).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it.each(["production",undefined,"","Production","demo "])("retains disabled-mode refusal before inspecting batch (%s)",async mode => {
    const primary = storage();
    Object.defineProperty(primary.db,"batch",{get() {throw new Error("Batch inspected in disabled mode");}});
    const response = await post({...credentials,GATEWAY_MODE:mode as BigQueryEnv["GATEWAY_MODE"],DB:primary.db});
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ok:false,code:"legacy_query_disabled"});
    expect(primary.catalogPrepare).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it.each([
    [{projectId:"invalid project"},"invalid_bigquery_project"],
    [{dataset:"bad-dataset"},"invalid_bigquery_dataset"],
    [{workspace:"bad workspace"},"invalid_workspace"],
    [{tablePrefix:"bad-prefix"},"invalid_table_prefix"]
  ] as const)("retains input validation before capability refusal for %j",async (invalid,code) => {
    const primary = storage(null);
    expect(await importBigQuerySchemaCatalog({GATEWAY_MODE:"demo",DB:primary.db},{...input,...invalid},actor))
      .toMatchObject({ok:false,status:400,code});
    expect(primary.prepare).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it.each(["DB","ODAP_GATEWAY_DB"] as const)("retains provider and confirmed storage on callable %s",async binding => {
    const primary = storage(), secondary = storage(null);
    const bindings = binding === "DB" ? {DB:primary.db} : {ODAP_GATEWAY_DB:primary.db,DB:secondary.db};
    const response = await post({...credentials,GATEWAY_MODE:"demo",...bindings});
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ok:true,import:{...input,importedTables:1,importedFields:1,tablePrefix:null}});
    expect(primary.batch).toHaveBeenCalledTimes(1);
    expect(secondary.prepare).not.toHaveBeenCalled();
    expect(calls).toEqual([tokenUrl,queryUrl]);
  });

  it("retains unauthenticated and non-admin refusals without provider or catalog work",async () => {
    const primary = storage(null);
    expect((await post({...credentials,GATEWAY_MODE:"demo",DB:primary.db},"")).status).toBe(401);
    expect((await post({...credentials,GATEWAY_MODE:"demo",DB:primary.db},memberCookie)).status).toBe(403);
    expect(primary.prepare).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("retains missing-storage and malformed-JSON refusals",async () => {
    expect(await importBigQuerySchemaCatalog({GATEWAY_MODE:"demo"},input,actor))
      .toMatchObject({ok:false,status:409,code:"storage_not_configured"});
    const unbound = await post({GATEWAY_MODE:"demo"});
    expect(unbound.status).toBe(503);
    expect(await unbound.json()).toMatchObject({code:"admin_authority_unavailable"});
    const primary = storage(null), invalid = await post({GATEWAY_MODE:"demo",DB:primary.db},cookie,"not-json");
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({code:"invalid_json"});
    expect(primary.catalogPrepare).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("retains missing-credential refusal for a callable binding without catalog work",async () => {
    const primary = storage();
    expect(await importBigQuerySchemaCatalog({GATEWAY_MODE:"demo",DB:primary.db},input,actor))
      .toMatchObject({ok:false,status:409,code:"bigquery_not_configured"});
    expect(primary.prepare).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("still refuses a binding that loses capability during the intercepted query",async () => {
    const primary = storage();
    vi.mocked(fetch).mockImplementation(async url => {
      calls.push(String(url));
      if (url === tokenUrl) return Response.json({access_token:"synthetic-token"});
      if (url !== queryUrl) throw new Error("Unexpected request");
      primary.db.batch = undefined;
      return Response.json(metadata);
    });
    expect(await importBigQuerySchemaCatalog({...credentials,GATEWAY_MODE:"demo",DB:primary.db},input,actor))
      .toMatchObject({ok:false,status:503,code:"schema_import_transaction_unavailable"});
    expect(primary.prepare).not.toHaveBeenCalled();
    expect(primary.batch).not.toHaveBeenCalled();
    expect(calls).toEqual([tokenUrl,queryUrl]);
  });

  it("does not claim a callable failing batch is healthy or fall back after provider work",async () => {
    const primary = storage(), secondary = storage();
    primary.batch.mockRejectedValue(new Error("Synthetic storage outage"));
    const response = await post({...credentials,GATEWAY_MODE:"demo",ODAP_GATEWAY_DB:primary.db,DB:secondary.db});
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ok:false,code:"internal_error"});
    expect(primary.batch).toHaveBeenCalledTimes(1);
    expect(secondary.prepare).not.toHaveBeenCalled();
    expect(calls).toEqual([tokenUrl,queryUrl]);
  });
});
