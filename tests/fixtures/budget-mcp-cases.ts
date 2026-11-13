import { expect, it } from "vitest";
import worker from "../../worker";
import { reserveAuxiliaryCost, settleAuxiliaryCost } from "../../lib/auxiliary-costs";
import { handleCoverageToolRequest } from "../../lib/coverage-mcp";
import type { D1Database, D1PreparedStatement } from "../../lib/d1";
import { bill, reservation } from "./auxiliary-cost-cases";
import { budgetReadRequest, budgetRequestCookie, budgetRequestEnv } from "./budget-request-cases";

const call = (args: unknown) => ({ jsonrpc:"2.0",id:37,method:"tools/call",params:{
  name:"odap_budget_reconciliation",arguments:args,_meta:{principalId:"google:owner",role:"owner",tenantId:"t"}
} });
export async function budgetToolBody(request: Request, db: D1Database, tenantId="t", budgetId="b") {
  const reply = await handleCoverageToolRequest(request,budgetRequestEnv(db),call({tenantId,budgetId}));
  if (!("result" in reply) || !reply.result.content) throw new Error("Expected tool content");
  expect(reply.id).toBe(37);
  const body = JSON.parse(reply.result.content[0].text);
  expect(reply.result.isError).toBe(!body.ok);
  return body;
}

export function budgetMcpCases(database:()=>D1Database, legacyDatabase:()=>Promise<D1Database>) {
  const run=(sql:string)=>database().prepare(sql).run();
  async function parity(request:Request, status:number, tenant="t", budget="b", db=database()) {
    const response=await worker.fetch(request,budgetRequestEnv(db),{waitUntil:()=>undefined});
    expect(response.status).toBe(status);expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body=await response.json();
    expect(await budgetToolBody(request,db,tenant,budget)).toEqual(body);
    return body;
  }
  it("returns the same mixed SQL/model/tool report without treating it as an execution grant",async()=>{
    const access={db:database(),tenantId:"t",principalId:"google:owner"};
    await reserveAuxiliaryCost(access,reservation);await settleAuxiliaryCost(access,reservation.id,bill);
    await reserveAuxiliaryCost(access,{...reservation,id:"tool-1",kind:"tool",operationRef:"fixture:tool",upperBoundMicroUsd:25});
    const body=await parity(budgetReadRequest(await budgetRequestCookie()),200);
    expect(body).toMatchObject({ok:true,reconciliation:{completeWorkflowCost:false,issuerAuthenticated:false,
      executionAuthorized:false,totals:{recordedActualMicroUsd:"12",pendingReservedMicroUsd:"45",pendingComponents:2}}});
    expect(JSON.stringify(body)).not.toMatch(/fixture:|google:owner|operationDigest|billingRef/);
  });
  it.each(["reader","reviewer","inactive","absent","outsider"])("rejects %s despite client metadata and a signed global-admin role",async subject=>{
    expect(await parity(budgetReadRequest(await budgetRequestCookie(subject)),403))
      .toEqual({ok:false,code:"tenant_access_denied"});
  });
  it.each(["missing","expired","tampered"])("rejects %s authentication without storage access",async kind=>{
    let reads=0;const db={prepare:()=>{reads++;throw new Error("No storage access");}};
    const cookie=kind==="missing"?"":kind==="expired"?await budgetRequestCookie("owner",Date.now()-1000):(await budgetRequestCookie())+"x";
    expect(await parity(budgetReadRequest(cookie),401,"t","b",db)).toEqual({ok:false,code:"unauthenticated"});
    expect(reads).toBe(0);
  });
  it("reads only the owned tenant when budget IDs match",async()=>{
    expect(await parity(budgetReadRequest(await budgetRequestCookie("outsider"),"peer"),200,"peer"))
      .toMatchObject({reconciliation:{tenantId:"peer",budgetId:"b",ledger:{limitMicroUsd:"777"},totals:{pendingComponents:0}}});
  });
  it("rejects the same budget ID in a tenant the principal does not own",async()=>{
    expect(await parity(budgetReadRequest(await budgetRequestCookie(),"peer"),403,"peer"))
      .toEqual({ok:false,code:"tenant_access_denied"});
  });
  it("does not distinguish a missing budget from denied access",async()=>{
    expect(await parity(budgetReadRequest(await budgetRequestCookie(),"t","missing"),403,"t","missing"))
      .toEqual({ok:false,code:"tenant_access_denied"});
  });
  it("rejects impersonation, extra arguments and malformed IDs before database access",async()=>{
    let reads=0;const db={prepare:()=>{reads++;throw new Error("No storage access");}};
    const request=budgetReadRequest(await budgetRequestCookie());
    for(const args of [{},{tenantId:"t"},{budgetId:"b"},{tenantId:"t",budgetId:3},
      ...["principalId","role","cookie","sql","endpoint"].map(key=>({tenantId:"t",budgetId:"b",[key]:"untrusted"}))])
      expect(await handleCoverageToolRequest(request,budgetRequestEnv(db),call(args))).toMatchObject({error:{code:-32602}});
    for(const id of ["bad!","a/b","a%2Fb","x".repeat(129)])
      expect(await budgetToolBody(request,db,"t",id)).toEqual({ok:false,code:"invalid_control_path"});
    expect(await budgetToolBody(request,db,"bad!","b")).toEqual({ok:false,code:"invalid_control_path"});
    expect(reads).toBe(0);
  });
  it("rejects unknown tools, write methods, notifications and batches before storage",async()=>{
    let reads=0;const db={prepare:()=>{reads++;throw new Error("No storage access");}};
    const request=budgetReadRequest(await budgetRequestCookie()),message=call({tenantId:"t",budgetId:"b"});
    const dispatch=(value:unknown)=>handleCoverageToolRequest(request,budgetRequestEnv(db),value);
    expect(await dispatch({...message,params:{...message.params,name:"repair_budget"}})).toMatchObject({error:{code:-32602}});
    expect(await dispatch({...message,method:"resources/write"})).toMatchObject({error:{code:-32601}});
    expect(await dispatch({...message,id:undefined})).toMatchObject({id:null,error:{code:-32600}});
    expect(await dispatch([message])).toMatchObject({id:null,error:{code:-32600}});
    expect(await dispatch({...message,params:{...message.params,principalId:"google:owner"}})).toMatchObject({error:{code:-32602}});
    expect(reads).toBe(0);
  });
  it("lists static read-only tools without leaking a tenant or probing storage",async()=>{
    const db={prepare:()=>{throw new Error("Do not inspect storage while listing");}};
    const reply=await handleCoverageToolRequest(budgetReadRequest(""),budgetRequestEnv(db),{jsonrpc:"2.0",id:1,method:"tools/list"});
    if (!("result" in reply) || !reply.result.tools) throw new Error("Expected tool list");
    expect(reply.result.tools.map(t=>t.name)).toEqual(["odap_evidence_coverage","odap_budget_reconciliation","odap_job_recovery", "odap_settled_evidence", "odap_cancellation_evidence"]);
    expect(reply.result.tools[1]).toMatchObject({inputSchema:{required:["tenantId","budgetId"],additionalProperties:false},
      annotations:{readOnlyHint:true,openWorldHint:false}});
  });
  it("denies a non-owner before inspecting schema 0032",async()=>{
    const db=await legacyDatabase();
    expect(await parity(budgetReadRequest(await budgetRequestCookie("reader")),403,"t","b",db)).toEqual({ok:false,code:"tenant_access_denied"});
  });
  it("keeps unavailable schema 0032 distinct from empty accounting",async()=>{
    const db=await legacyDatabase();
    expect(await parity(budgetReadRequest(await budgetRequestCookie()),503,"t","b",db)).toEqual({ok:false,code:"budget_accounting_unavailable"});
  });
  it.each(["membership","capability"])("rechecks ownership after %s changes on both transports",async phase=>{
    const base=database();
    for(const transport of ["REST","MCP"]){
      await run("UPDATE control_memberships SET active=1 WHERE principal_id='google:owner'");
      let revoked=false;
      const db:D1Database={prepare(sql){const p=base.prepare(sql);
        if(!(phase==="membership"?sql.startsWith("SELECT role FROM control_memberships"):sql.includes("sqlite_master")))return p;
        const wrap=(s:D1PreparedStatement):D1PreparedStatement=>({...s,bind:(...args)=>wrap(s.bind(...args)),first:async<T>()=>{
          const value=await s.first<T>();await run("UPDATE control_memberships SET active=0 WHERE principal_id='google:owner'");revoked=true;return value;
        }});return wrap(p);
      }};
      const request=budgetReadRequest(await budgetRequestCookie());
      const body=transport==="MCP"?await budgetToolBody(request,db):
        await(await worker.fetch(request,budgetRequestEnv(db),{waitUntil:()=>undefined})).json();
      expect(revoked).toBe(true);expect(body).toEqual({ok:false,code:"tenant_access_denied"});
    }
  });
  it.each(["membership","capability","snapshot"])("sanitizes %s storage failures identically",async phase=>{
    const base=database();const db:D1Database={prepare(sql){
      if(phase==="membership"||phase==="capability"&&sql.includes("sqlite_master")||phase==="snapshot"&&sql.includes("AS sql_rows"))
        throw new Error("Private database diagnostic");
      return base.prepare(sql);
    }};
    expect(await parity(budgetReadRequest(await budgetRequestCookie()),503,"t","b",db)).toEqual({ok:false,code:"control_storage_unavailable"});
  });
  it("does not cache schema capability between tool calls",async()=>{
    const request=budgetReadRequest(await budgetRequestCookie());
    expect(await budgetToolBody(request,database())).toMatchObject({ok:true});
    await run("ALTER TABLE auxiliary_cost_settlements RENAME TO unavailable_settlements");
    expect(await parity(request,503)).toEqual({ok:false,code:"budget_accounting_unavailable"});
  });
  it("reports discrepancies without making them RPC failures or performing repairs",async()=>{
    await run("UPDATE control_budgets SET reserved_units=19 WHERE tenant_id='t' AND id='b'");
    expect(await parity(budgetReadRequest(await budgetRequestCookie()),200))
      .toMatchObject({ok:true,reconciliation:{consistent:false,countersConsistent:false,difference:{reservedMicroUsd:"1"}}});
    expect(await database().prepare("SELECT reserved_units FROM control_budgets WHERE tenant_id='t'").first()).toEqual({reserved_units:19});
  });
  it("only reads current-owner statements without changing accounting or audit records",async()=>{
    const base=database(),queries:string[]=[];
    const q="SELECT reserved_units,spent_units,overrun_units,(SELECT count(*) FROM control_object_events) AS events FROM control_budgets WHERE tenant_id='t'";
    const before=await base.prepare(q).first();
    const db:D1Database={prepare(sql){queries.push(sql);expect(sql.trim()).toMatch(/^SELECT /);return base.prepare(sql);}};
    expect(await budgetToolBody(budgetReadRequest(await budgetRequestCookie()),db)).toMatchObject({ok:true});
    expect(queries).toHaveLength(3);expect(await base.prepare(q).first()).toEqual(before);
  });
}
