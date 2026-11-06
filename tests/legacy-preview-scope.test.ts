import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { SESSION_COOKIE, signAuthPayload } from "../lib/auth";
import * as store from "../lib/admin-store";
import { runBigQueryDryRun } from "../lib/bigquery";
import { authorizeControlRequest } from "../lib/control-storage";
import { evaluateSchemaCatalog } from "../lib/schema-policy";
import worker from "../worker";
import { jobDatabase, jobSqlite } from "./fixtures/job-sqlite";

const secret = "synthetic-preview-scope-session";
const query = (project: string) => "SELECT order_id FROM `"+project+".demo.orders` WHERE order_date >= CURRENT_DATE()";
const cookies: Record<string,string> = {};
let dir: string, file: string, catalog: store.SchemaCatalogTable[];
const env = { GATEWAY_MODE:"production" as const, AUTH_COOKIE_SECRET:secret, DB:jobDatabase(() => file,"readonly"),
  BIGQUERY_PROJECT_ID:"fixture-billing",BIGQUERY_CLIENT_EMAIL:"fixture@example.test",BIGQUERY_PRIVATE_KEY:"",
  ASSETS:{fetch:async () => {throw new Error("Unexpected asset request");}} };

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(),"odap-preview-scope-"));
  file = join(dir,"fixture.db");
  await jobSqlite(file,"setup");
  await jobSqlite(file,"run","INSERT INTO control_tenants VALUES('peer','Peer')");
  await jobSqlite(file,"run","INSERT INTO control_memberships VALUES ('t','google:alice','owner',1),('peer','google:bob','owner',1)");
  for (const subject of ["alice","bob"]) {
    cookies[subject] = SESSION_COOKIE+"="+await signAuthPayload({provider:"google",providerId:subject,
      email:subject+"@example.test",name:"Fixture",expiresAt:Date.now()+600000},secret);
  }
  const seed = (await store.getSchemaPolicyCatalog({})).tables.find(t => t.name === "demo.orders")!;
  catalog = ["t","peer"].map(workspace => ({...seed,id:"orders-"+workspace,workspace,name:"fixture-"+workspace+".demo.orders"}));
  env.BIGQUERY_PRIVATE_KEY = generateKeyPairSync("rsa",{modulusLength:2048}).privateKey.export({format:"pem",type:"pkcs8"}).toString();
});
afterEach(() => {vi.restoreAllMocks();vi.unstubAllGlobals();});
afterAll(async () => {if (dir) await rm(dir,{recursive:true,force:true});});

describe("legacy preview scope", () => {
  it.each([["alice","t","peer"],["bob","peer","t"]])("rejects a peer project or workspace for %s",async (subject,own,peer) => {
    const headers = {Cookie:cookies[subject],"X-Tenant-Id":peer,"X-Principal-Id":"google:other"};
    const url = "https://fixture.test/api/query/dry-run";
    const req = new Request(url,{headers});
    expect(await authorizeControlRequest(req,env,own)).toMatchObject({ok:true,role:"owner"});
    expect(await authorizeControlRequest(req,env,peer)).toMatchObject({ok:false,status:403});
    const readCatalog = vi.spyOn(store,"getSchemaPolicyCatalog").mockResolvedValue({tables:catalog,source:"d1",storageBinding:"DB"});
    const calls: string[] = [];
    vi.stubGlobal("fetch",async (target: string, init: RequestInit) => {
      if (String(target) === "https://oauth2.googleapis.com/token") {
        calls.push("token"); return Response.json({access_token:"fixture-only"});
      }
      calls.push(JSON.parse(String(init.body)).configuration.query.query);
      return Response.json({error:{status:"SYNTHETIC_STOP"}},{status:403});
    });
    // The legacy request carries claims, not a trusted table binding. Even
    // the caller's own workspace name cannot establish the scope of raw SQL.
    for (const [workspace,project] of [[own,peer],[peer,peer],[own,own]]) {
      const res = await worker.fetch(new Request(url,{method:"POST",headers,body:JSON.stringify({
        sql:query("fixture-"+project),workspace,tenantId:own,contractId:"claimed",releaseId:"claimed",GATEWAY_MODE:"demo"
      })}),env,{waitUntil:() => undefined});
      expect(calls).toEqual([]);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ok:false,code:"production_preview_scope_unbound"});
    }
    expect(readCatalog).not.toHaveBeenCalled();
  });
  it("does not collapse two project-qualified catalog names to the same table", () => {
    for (const [own,peer] of [["t","peer"],["peer","t"]]) {
      expect(evaluateSchemaCatalog(query("fixture-"+own),own,catalog,"d1").blocked).toBe(false);
      expect(evaluateSchemaCatalog(query("fixture-"+peer),own,catalog,"d1").blocked).toBe(true);
    }
    const shortCatalog = [{...catalog[0],name:"demo.orders"}];
    expect(evaluateSchemaCatalog(query("fixture-t"),"t",shortCatalog,"d1").blocked).toBe(true);
  });
  it("does not treat a project name as an exempt column identifier", () => {
    const table = {...catalog[0],name:"salary.demo.orders",fields:[...catalog[0].fields,
      {...catalog[0].fields[0],id:"private-field",name:"salary",pii:false,queryable:false}]};
    const sql = query("salary")+" AND salary > 0";
    expect(evaluateSchemaCatalog(sql,"t",[table],"d1").reasons).toContain("salary.demo.orders.salary is not queryable");
  });
  it("also closes the raw transport below the HTTP handler",async () => {
    const outbound = vi.fn(async () => {throw new Error("Unexpected outbound request");});
    vi.stubGlobal("fetch",outbound);
    expect(await runBigQueryDryRun(query("fixture-peer"),env)).toMatchObject({
      status:"blocked",error:{code:"production_preview_scope_unbound"}
    });
    expect(outbound).not.toHaveBeenCalled();
  });
});
