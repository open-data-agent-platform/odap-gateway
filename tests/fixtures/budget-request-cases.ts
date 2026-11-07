import { expect, it } from "vitest";
import worker from "../../worker";
import { SESSION_COOKIE, signAuthPayload, type AuthSession } from "../../lib/auth";
import { reserveAuxiliaryCost, settleAuxiliaryCost } from "../../lib/auxiliary-costs";
import { requestBudgetReconciliation } from "../../lib/budget-reconciliation-request";
import type { D1Database, D1PreparedStatement } from "../../lib/d1";
import { bill, reservation } from "./auxiliary-cost-cases";

const secret="budget-request-synthetic-cookie-key";
export const budgetRequestMembers=[
  "INSERT INTO control_tenants VALUES('peer','Peer')",
  `INSERT INTO control_memberships VALUES('t','google:owner','owner',1),('t','google:reader','reader',1),
    ('t','google:reviewer','reviewer',1),('t','google:inactive','owner',0),('peer','google:outsider','owner',1)`,
  "INSERT INTO control_budgets(tenant_id,id,limit_units) VALUES('peer','b',777)"
];
export async function budgetRequestCookie(subject="owner",expiresAt=Date.now()+60000) {
  return SESSION_COOKIE+"="+await signAuthPayload({provider:"google",providerId:subject,role:"admin",
    email:"owner@example.test",name:"Fixture",expiresAt},secret);
}
const assets={fetch:async()=>{throw new Error("Unexpected asset fallback");}};
export const budgetRequestEnv=(db:D1Database)=>({DB:db,AUTH_COOKIE_SECRET:secret,ASSETS:assets});
export function budgetReadRequest(cookie:string,tenant="t",budget="b",query="",prefix="",method="GET") {
  return new Request(`https://gateway.test${prefix}/api/control/${tenant}/budget-reconciliation/${budget}${query}`,
    {method,headers:{Cookie:cookie,"X-Tenant-Id":"t","X-Principal-Id":"google:owner","X-Role":"owner"}});
}
const fetchWorker=(request:Request,db:D1Database,prefix="")=>worker.fetch(request,
  {...budgetRequestEnv(db),GATEWAY_BASE_PATH:prefix},{waitUntil:()=>undefined});

export function budgetRequestCases(database:()=>D1Database,oldDatabase:()=>Promise<D1Database>) {
  const access=()=>({db:database(),tenantId:"t",principalId:"google:owner"});
  const run=(sql:string)=>database().prepare(sql).run();
  async function response(subject="owner",tenant="t",budget="b",db=database()) {
    return fetchWorker(budgetReadRequest(await budgetRequestCookie(subject),tenant,budget),db);
  }
  it.each(["reader","reviewer","inactive","absent","outsider"])("rejects %s despite signed global-admin role and forged headers",async subject=>{
    const r=await response(subject);expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ok:false,code:"tenant_access_denied"});
    expect(r.headers.get("Cache-Control")).toBe("no-store");
  });
  it.each(["missing","expired","tampered","oauth-state","email-only"])("rejects %s authentication before touching storage",async kind=>{
    let calls=0;
    const db={prepare:()=>{calls++;throw new Error("Do not inspect schema");}};
    const token=kind==="expired"?await budgetRequestCookie("owner",Date.now()-1000):
      kind==="tampered"?(await budgetRequestCookie())+"x":kind==="missing"?"":
      SESSION_COOKIE+"="+await signAuthPayload(kind==="oauth-state"
        ? {provider:"google",nonce:"fixture",returnTo:"/",expiresAt:Date.now()+60000}
        // Deliberately signed malformed session: email and global role are not a principal.
        : {provider:"google",email:"owner@example.test",role:"admin",expiresAt:Date.now()+60000} as AuthSession,secret);
    const r=await fetchWorker(budgetReadRequest(token),db);
    expect(r.status).toBe(401);expect(await r.json()).toEqual({ok:false,code:"unauthenticated"});expect(calls).toBe(0);
  });
  it("returns the same bounded owner report through the service and real Worker route",async()=>{
    await reserveAuxiliaryCost(access(),reservation);await settleAuxiliaryCost(access(),reservation.id,bill);
    await reserveAuxiliaryCost(access(),{...reservation,id:"tool-1",kind:"tool",operationRef:"fixture:tool",upperBoundMicroUsd:25});
    const request=budgetReadRequest(await budgetRequestCookie());
    const r=await fetchWorker(request,database());expect(r.status).toBe(200);
    const body=await r.json();expect(body).toEqual((await requestBudgetReconciliation(request,budgetRequestEnv(database()),"t","b")).body);
    expect(body).toMatchObject({ok:true,reconciliation:{consistent:true,completeWorkflowCost:false,issuerAuthenticated:false,
      executionAuthorized:false,totals:{recordedActualMicroUsd:"12",pendingReservedMicroUsd:"45",pendingComponents:2}}});
    expect(JSON.stringify(body)).not.toMatch(/fixture:|google:owner|operationDigest|billingRef/);
    expect(r.headers.get("Cache-Control")).toBe("no-store");expect(r.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });
  it("isolates identical budget IDs across tenants without trusting the requested scope",async()=>{
    const r=await response("outsider","peer");expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({reconciliation:{tenantId:"peer",budgetId:"b",ledger:{limitMicroUsd:"777"},
      totals:{recordedActualMicroUsd:"0",pendingReservedMicroUsd:"0",pendingComponents:0}}});
    expect((await response("owner","peer")).status).toBe(403);
    expect((await response("owner","t","missing")).status).toBe(403);
  });
  it("supports a mounted Gateway path without changing the requested tenant",async()=>{
    const r=await fetchWorker(budgetReadRequest(await budgetRequestCookie(),"t","b","","/gateway"),database(),"/gateway");
    expect(r.status).toBe(200);expect(await r.json()).toMatchObject({reconciliation:{tenantId:"t",budgetId:"b"}});
  });
  it("returns accounting differences without granting repair or execution",async()=>{
    await run("UPDATE control_budgets SET reserved_units=19 WHERE tenant_id='t' AND id='b'");
    const r=await response();expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({reconciliation:{consistent:false,countersConsistent:false,
      difference:{reservedMicroUsd:"1"},executionAuthorized:false}});
    expect(await database().prepare("SELECT reserved_units FROM control_budgets WHERE tenant_id='t'").first()).toEqual({reserved_units:19});
  });
  it.each(["membership","capability"])("rechecks current owner after %s changes",async phase=>{
    const base=database();let revoked=false;
    const db:D1Database={prepare(sql){
      const p=base.prepare(sql);
      if (!(phase==="membership"?sql.startsWith("SELECT role FROM control_memberships"):sql.includes("sqlite_master"))) return p;
      const wrap=(s:D1PreparedStatement):D1PreparedStatement=>({...s,bind:(...args)=>wrap(s.bind(...args)),first:async<T>()=>{
        const row=await s.first<T>();await run("UPDATE control_memberships SET active=0 WHERE principal_id='google:owner'");
        revoked=true;return row;
      }});return wrap(p);
    }};
    const r=await response("owner","t","b",db);expect(revoked).toBe(true);expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ok:false,code:"tenant_access_denied"});
  });
  it.each(["membership","capability","snapshot"])("sanitizes %s storage failure",async phase=>{
    const base=database();
    const db:D1Database={prepare(sql){
      if (phase==="membership"||phase==="capability"&&sql.includes("sqlite_master")||phase==="snapshot"&&sql.includes("AS sql_rows"))
        throw new Error("private storage connection secret");
      return base.prepare(sql);
    }};
    const r=await response("owner","t","b",db);expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ok:false,code:"control_storage_unavailable"});
  });
  it("reports unavailable on schema 0032 only after current tenant authorization",async()=>{
    const db=await oldDatabase();
    expect((await response("reader","t","b",db)).status).toBe(403);
    const r=await response("owner","t","b",db);expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ok:false,code:"budget_accounting_unavailable"});
    expect(await db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'auxiliary_cost_%'").first()).toEqual({n:0});
  });
  it("does not accept a partially installed accounting schema",async()=>{
    const db=await oldDatabase();await db.prepare("CREATE TABLE auxiliary_cost_reservations (id TEXT)").run();
    const r=await response("owner","t","b",db);expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ok:false,code:"budget_accounting_unavailable"});
  });
  it("does not treat views with the expected names as installed accounting tables",async()=>{
    const db=await oldDatabase();
    await db.prepare("CREATE VIEW auxiliary_cost_reservations AS SELECT 1 AS id").run();
    await db.prepare("CREATE VIEW auxiliary_cost_settlements AS SELECT 1 AS id").run();
    const r=await response("owner","t","b",db);expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ok:false,code:"budget_accounting_unavailable"});
  });
  it("rejects malformed installed storage instead of reporting empty costs",async()=>{
    await run("ALTER TABLE auxiliary_cost_settlements RENAME COLUMN actual_units TO unavailable_units");
    const r=await response();expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ok:false,code:"control_storage_unavailable"});
  });
  it("does not cache schema capability across requests",async()=>{
    expect((await response()).status).toBe(200);
    await run("ALTER TABLE auxiliary_cost_settlements RENAME TO unavailable_settlements");
    const r=await response();expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ok:false,code:"budget_accounting_unavailable"});
  });
  it.each(["POST","PATCH","DELETE","HEAD","OPTIONS"])("rejects %s without executing database operations",async method=>{
    let reads=0;const db={prepare:()=>{reads++;throw new Error("Unexpected read");}};
    const r=await fetchWorker(budgetReadRequest(await budgetRequestCookie(),"t","b","","",method),db);
    expect(r.status).toBe(405);expect(r.headers.get("Allow")).toBe("GET");expect(reads).toBe(0);
  });
  it.each(["?view=repair","?principalId=google:owner","?budgetId=peer"])("rejects unexpected query %s before storage",async query=>{
    let reads=0;const db={prepare:()=>{reads++;throw new Error("Unexpected read");}};
    const r=await fetchWorker(budgetReadRequest(await budgetRequestCookie(),"t","b",query),db);
    expect(r.status).toBe(400);expect(await r.json()).toEqual({ok:false,code:"invalid_budget_view"});expect(reads).toBe(0);
  });
  it.each(["bad!","b%2Fpeer","b%00","b%252Fpeer","b".repeat(129)])("rejects malformed budget path %# before storage",async budget=>{
    let reads=0;const db={prepare:()=>{reads++;throw new Error("Unexpected read");}};
    const r=await fetchWorker(budgetReadRequest(await budgetRequestCookie(),"t",budget),db);
    expect(r.status).toBe(400);expect(await r.json()).toEqual({ok:false,code:"invalid_control_path"});expect(reads).toBe(0);
  });
  it("performs only read statements without changing accounting or audit rows",async()=>{
    const base=database(),queries:string[]=[];
    const q="SELECT reserved_units,spent_units,overrun_units,(SELECT count(*) FROM control_object_events) AS events FROM control_budgets WHERE tenant_id='t'";
    const before=await base.prepare(q).first();
    const db:D1Database={prepare(sql){queries.push(sql);expect(sql.trim()).toMatch(/^SELECT /);return base.prepare(sql);}};
    expect((await response("owner","t","b",db)).status).toBe(200);expect(queries).toHaveLength(3);
    expect(await base.prepare(q).first()).toEqual(before);
  });
}
