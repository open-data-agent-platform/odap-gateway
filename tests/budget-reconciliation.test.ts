import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readBudgetReconciliation } from "../lib/budget-reconciliation";
import type { ControlAccess } from "../lib/control-storage";
import type { D1PreparedStatement } from "../lib/d1";
import { budgetReconciliationCases } from "./fixtures/budget-reconciliation-cases";
import { jobSqlite, jobTransactionalDatabase } from "./fixtures/job-sqlite";

let dir:string,file:string;
const access=()=>({db:jobTransactionalDatabase(()=>file),tenantId:"t",principalId:"owner"});
describe("combined budget reconciliation on SQLite",()=>{
  beforeEach(async()=>{dir=await mkdtemp(join(tmpdir(),"odap-budget-read-"));file=join(dir,"ledger.sqlite");await jobSqlite(file,"setup");});
  afterEach(async()=>{if(dir)await rm(dir,{recursive:true,force:true});});
  budgetReconciliationCases(access);
  it("does not treat a v32 database as an empty auxiliary ledger",async()=>{
    file=join(dir,"old.sqlite");await jobSqlite(file,"setup-v32");const before=await readFile(file);
    await expect(readBudgetReconciliation(access(),"b")).rejects.toThrow(/^Budget accounting unavailable$/);
    expect((await readFile(file)).equals(before)).toBe(true);
  });
});

describe("budget reconciliation input boundaries",()=>{
  const snapshot={limit_units:100,reserved_units:0,spent_units:0,overrun_units:0,
    sql_rows:"[]",auxiliary_rows:"[]",unattributed:0};
  const mockAccess=(row:unknown):ControlAccess=>{
    const statement:D1PreparedStatement={bind:()=>statement,first:async<T>()=>row as T,
      all:async()=>{throw new Error("Unexpected all");},run:async()=>{throw new Error("Unexpected write");}};
    return {tenantId:"t",principalId:"owner",db:{prepare:()=>statement}};
  };
  it.each([""," ","b\n", "b".repeat(1025)])("rejects invalid budget ID %# before any storage access",async budgetId=>{
    let calls=0;
    const invalidAccess={...mockAccess(snapshot),db:{prepare:()=>{calls++;throw new Error("private storage diagnostics");}}};
    await expect(readBudgetReconciliation(invalidAccess,budgetId)).rejects.toThrow(/^Invalid budget accounting snapshot$/);
    expect(calls).toBe(0);
  });
  it("does not leak storage exception details",async()=>{
    const failed={...mockAccess(snapshot),db:{prepare:()=>{throw new Error("private storage diagnostics");}}};
    await expect(readBudgetReconciliation(failed,"b")).rejects.toThrow(/^Budget accounting unavailable$/);
  });
  it.each([-1,-0,0.5,Number.MAX_SAFE_INTEGER+1,"1",null,Infinity,NaN])("rejects malformed stored amounts %#",async amount=>{
    await expect(readBudgetReconciliation(mockAccess({...snapshot,spent_units:amount}),"b")).rejects.toThrow(/^Invalid budget accounting snapshot$/);
  });
  it.each([
    ["SQL overflow",{sql_rows:JSON.stringify(Array.from({length:1025},()=>({})))}],
    ["non-array inventory",{sql_rows:"{}"}],
    ["invalid JSON",{auxiliary_rows:"["}],
    ["invalid row",{auxiliary_rows:"[null]"}],
    ["byte overflow",{auxiliary_rows:JSON.stringify([{"id":"\u00e9".repeat(2*1024*1024)}])}]
  ])("rejects %s without returning a partial result",async(_label,change)=>{
    await expect(readBudgetReconciliation(mockAccess({...snapshot,...change}),"b")).rejects.toThrow(/^Invalid budget accounting snapshot$/);
  });
});
