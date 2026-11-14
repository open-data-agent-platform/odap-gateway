import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const require=createRequire(import.meta.url);
const bundler=createRequire(require.resolve("wrangler/package.json"))("esbuild") as typeof import("esbuild");
let mf: Miniflare,db: Awaited<ReturnType<Miniflare["getD1Database"]>>,outbound=0;
const submit=(path="/live")=>mf.dispatchFetch("http://localhost"+path,{method:"POST",
  body:JSON.stringify({sql:"SELECT contact FROM fixture.orders",workspace:"fixture"})});

describe("ambiguous catalog refusal in installed Worker and D1",()=>{
  beforeAll(async()=>{
    const bundle=await bundler.build({bundle:true,write:false,format:"esm",platform:"browser",
      stdin:{resolveDir:resolve(__dirname,".."),contents:`
        import worker from "./worker";
        import {ensureAdminSchema} from "./lib/admin-store";
        import {signAuthPayload,SESSION_COOKIE} from "./lib/auth";
        export default {async fetch(incoming,env){
          await ensureAdminSchema(env.DB);
          const path=new URL(incoming.url).pathname;
          if(path==="/bootstrap")return new Response("Synthetic local schema ready");
          const secret="synthetic-identity-cookie";
          const token=await signAuthPayload({provider:"google",providerId:"fixture",email:"fixture@example.test",
            name:"Fixture",expiresAt:Date.now()+60000},secret);
          return worker.fetch(new Request("https://gateway.test/gateway/api/query/dry-run",{
            method:"POST",body:await incoming.text(),headers:{"Content-Type":"application/json",Cookie:SESSION_COOKIE+"="+token}
          }),{DB:env.DB,GATEWAY_BASE_PATH:"/gateway",GATEWAY_MODE:path==="/production"?"production":"demo",
            AUTH_COOKIE_SECRET:secret,...(path==="/simulated"?{}:{BIGQUERY_PROJECT_ID:"fixture-project",
              BIGQUERY_CLIENT_EMAIL:"fixture@example.test",BIGQUERY_PRIVATE_KEY:"synthetic-unused"}),
            ASSETS:{fetch(){throw new Error("Unexpected asset request");}}
          },{waitUntil(){throw new Error("Unexpected background task");}});
        }}
      `}});
    const config=JSON.parse(readFileSync(resolve(__dirname,"../wrangler.example.jsonc"),"utf8"));
    mf=new Miniflare({host:"127.0.0.1",port:0,modules:true,script:bundle.outputFiles[0].text,
      compatibilityDate:config.compatibility_date,d1Databases:{DB:"synthetic-identity"},d1Persist:false,
      outboundService:()=>{outbound++;throw new Error("Unexpected provider request");}});
    expect((await mf.dispatchFetch("http://localhost/bootstrap")).status).toBe(200);
    db=await mf.getD1Database("DB");
  },30000);
  beforeEach(async()=>{
    await db.batch([
      db.prepare("DELETE FROM schema_fields WHERE table_id IN ('identity-a','identity-b')"),
      db.prepare("DELETE FROM schema_tables WHERE id IN ('identity-a','identity-b')"),
      db.prepare("INSERT INTO schema_tables VALUES('identity-a','fixture','fixture.orders','Synthetic',0,'fixture')"),
      db.prepare("INSERT INTO schema_fields VALUES('identity-a-field','identity-a','contact','STRING','NULLABLE','Synthetic',0,1,0,'fixture')")
    ]);
  });
  afterAll(async()=>{await mf?.dispose();expect(outbound).toBe(0);});

  it.each([
    ["workspace case","FIXTURE","fixture.orders"],
    ["quoted table","fixture","`fixture.orders`"],
    ["padded table","fixture"," fixture.orders "]
  ])("persists a blocked preview before provider access for %s",async(_label,workspace,name)=>{
    await db.batch([
      db.prepare("INSERT INTO schema_tables VALUES('identity-b',?,?,'Synthetic',0,'fixture')").bind(workspace,name),
      db.prepare("INSERT INTO schema_fields VALUES('identity-b-field','identity-b','contact','STRING','NULLABLE','Synthetic',1,0,0,'fixture')")
    ]);
    const before=await db.prepare("SELECT * FROM schema_tables WHERE id IN ('identity-a','identity-b') ORDER BY id").all();
    const response=await submit();expect(response.status).toBe(200);
    const body=await response.json() as {runId:string};
    expect(body).toMatchObject({persisted:true,preview:{status:"blocked",scannedBytes:0,estimatedCostUsd:0,
      error:{code:"schema_policy_blocked"},checks:expect.arrayContaining([
        expect.objectContaining({label:"Workspace table allowlist",status:"warn",
          detail:"fixture.orders has ambiguous catalog identity in the fixture workspace"})])}});
    expect(await db.prepare("SELECT status FROM query_runs WHERE id=?").bind(body.runId).first()).toEqual({status:"blocked"});
    expect((await db.prepare("SELECT * FROM schema_tables WHERE id IN ('identity-a','identity-b') ORDER BY id").all()).results).toEqual(before.results);
    expect(outbound).toBe(0);
  });
  it("retains a unique simulated preview without provider credentials",async()=>{
    const response=await submit("/simulated");expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({persisted:true,preview:{mode:"simulated",configured:false,
      error:{code:"bigquery_not_configured"}}});
    expect(outbound).toBe(0);
  });
  it("does not reopen production raw preview",async()=>{
    const response=await submit("/production");expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ok:false,code:"production_preview_scope_unbound"});
    expect(outbound).toBe(0);
  });
});
