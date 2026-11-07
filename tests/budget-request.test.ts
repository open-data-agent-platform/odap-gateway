import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { requestBudgetReconciliation } from "../lib/budget-reconciliation-request";
import { jobDatabase, jobSqlite, jobTransactionalDatabase } from "./fixtures/job-sqlite";
import { budgetRequestCases, budgetRequestCookie, budgetRequestEnv, budgetRequestMembers, budgetReadRequest } from "./fixtures/budget-request-cases";

let dir:string,file:string;
async function setup(path:string,mode="setup") {
  await jobSqlite(path,mode);
  const db=jobTransactionalDatabase(()=>path);
  await db.batch!(budgetRequestMembers.map(sql=>db.prepare(sql)));
  return db;
}
describe("authenticated budget reconciliation on SQLite",()=>{
  beforeAll(()=>{vi.spyOn(globalThis,"fetch").mockRejectedValue(new Error("Network disabled"));});
  beforeEach(async()=>{dir=await mkdtemp(join(tmpdir(),"odap-budget-api-"));file=join(dir,"ledger.db");await setup(file);});
  afterEach(async()=>{await rm(dir,{recursive:true,force:true});});
  afterAll(()=>{try{expect(globalThis.fetch).not.toHaveBeenCalled();}finally{vi.restoreAllMocks();}});
  budgetRequestCases(()=>jobTransactionalDatabase(()=>file),()=>setup(join(dir,"old.db"),"setup-v32"));
  it("leaves a read-only v32 database byte-identical without bootstrapping",async()=>{
    const path=join(dir,"readonly.db");await setup(path,"setup-v32");const before=await readFile(path);
    const db=jobDatabase(()=>path,"readonly");
    const r=await requestBudgetReconciliation(budgetReadRequest(await budgetRequestCookie()),budgetRequestEnv(db),"t","b");
    expect(r).toEqual({status:503,body:{ok:false,code:"budget_accounting_unavailable"}});
    expect((await readFile(path)).equals(before)).toBe(true);
  });
});
