import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, vi } from "vitest";
import type { D1Database } from "../lib/d1";
import { jobSqlite } from "./fixtures/job-sqlite";
import { budgetRequestCases, budgetRequestMembers } from "./fixtures/budget-request-cases";

let mf:Miniflare,db:D1Database,statements:string[],boundary:number,sequence=0;
async function setup(target:D1Database,legacy=false) {
  await target.batch!((legacy?statements.slice(0,boundary):statements).map(sql=>target.prepare(sql)));
  await target.batch!([
    target.prepare("INSERT INTO control_tenants VALUES('t','Tenant')"),
    target.prepare("INSERT INTO control_memberships VALUES('t','owner','owner',1),('t','user','reader',1)"),
    target.prepare("INSERT INTO semantic_releases(tenant_id,id,payload,created_by) VALUES('t','r',?,'owner')").bind(JSON.stringify({id:"r",tenantId:"t"})),
    target.prepare("INSERT INTO approval_contracts(tenant_id,id,release_id,payload,created_by) VALUES('t','c','r',?,'owner')")
      .bind(JSON.stringify({id:"c",tenantId:"t",semanticReleaseId:"r",state:"authorized",principalId:"user",actionDigest:"digest",
        reservationId:"s",expiresAt:"2099-01-01T00:00:00.000Z"})),
    target.prepare("INSERT INTO control_budgets(tenant_id,id,limit_units) VALUES('t','b',100)"),
    target.prepare("INSERT INTO execution_intents VALUES('t','i','c','b','s','user','digest',20,'now')"),
    ...budgetRequestMembers.map(sql=>target.prepare(sql))
  ]);
  return target;
}
describe("authenticated budget reconciliation on installed native D1",()=>{
  beforeAll(async()=>{
    vi.spyOn(globalThis,"fetch").mockRejectedValue(new Error("Network disabled"));
    statements=await jobSqlite(":memory:","migration-statements");
    boundary=statements.findIndex(sql=>sql.includes("CREATE TABLE auxiliary_cost_reservations"));expect(boundary).toBeGreaterThan(0);
  });
  beforeEach(async()=>{
    await mf?.dispose();mf=new Miniflare({host:"127.0.0.1",port:0,modules:true,
      script:"export default {fetch(){return new Response('Local budget request');}}",
      d1Databases:{DB:"budget-api-"+(++sequence),OLD:"budget-api-old-"+sequence},d1Persist:false});
    db=await setup(await mf.getD1Database("DB") as unknown as D1Database);
  },30000);
  afterAll(async()=>{try{await mf?.dispose();expect(globalThis.fetch).not.toHaveBeenCalled();}finally{vi.restoreAllMocks();}});
  budgetRequestCases(()=>db,async()=>setup(await mf.getD1Database("OLD") as unknown as D1Database,true));
});
