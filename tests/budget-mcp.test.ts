import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { jobDatabase, jobSqlite, jobTransactionalDatabase } from "./fixtures/job-sqlite";
import { budgetMcpCases, budgetToolBody } from "./fixtures/budget-mcp-cases";
import { budgetReadRequest, budgetRequestCookie, budgetRequestMembers } from "./fixtures/budget-request-cases";

let dir:string,file:string;
async function setup(path:string,mode="setup") {
  await jobSqlite(path,mode);const db=jobTransactionalDatabase(()=>path);
  await db.batch!(budgetRequestMembers.map(sql=>db.prepare(sql)));return db;
}
describe("budget REST/MCP policy parity on SQLite",()=>{
  beforeAll(()=>{vi.spyOn(globalThis,"fetch").mockRejectedValue(new Error("Network disabled"));});
  beforeEach(async()=>{dir=await mkdtemp(join(tmpdir(),"odap-budget-mcp-"));file=join(dir,"ledger.db");await setup(file);});
  afterEach(async()=>{await rm(dir,{recursive:true,force:true});});
  afterAll(()=>{try{expect(globalThis.fetch).not.toHaveBeenCalled();}finally{vi.restoreAllMocks();}});
  budgetMcpCases(()=>jobTransactionalDatabase(()=>file),()=>setup(join(dir,"old.db"),"setup-v32"));
  it.each(["setup","setup-v32"])("leaves a read-only %s file byte-identical",async mode=>{
    const path=join(dir,mode+".db");await setup(path,mode);const before=await readFile(path);
    const result=await budgetToolBody(budgetReadRequest(await budgetRequestCookie()),jobDatabase(()=>path,"readonly"));
    expect(result.ok).toBe(mode==="setup");expect((await readFile(path)).equals(before)).toBe(true);
  });
});
