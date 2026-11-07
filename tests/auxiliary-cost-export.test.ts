import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { jobSqlite, jobTransactionalDatabase } from "./fixtures/job-sqlite";
import { auxiliaryExportCases } from "./fixtures/auxiliary-export-cases";
import { exportAuxiliaryCostEvidence } from "../lib/auxiliary-cost-evidence-export";

let dir: string, file: string;
const access=() => ({db:jobTransactionalDatabase(() => file),tenantId:"t",principalId:"owner"});
describe("auxiliary evidence export on SQLite",() => {
  beforeEach(async () => {dir=await mkdtemp(join(tmpdir(),"odap-aux-export-"));file=join(dir,"ledger.db");await jobSqlite(file,"setup");});
  afterEach(async () => {await rm(dir,{recursive:true,force:true});});
  auxiliaryExportCases(access);
  it("fails closed on unmigrated storage without modifying it",async () => {
    file=join(dir,"old.db"); await jobSqlite(file,"setup-v32");
    await expect(exportAuxiliaryCostEvidence(access(),"i")).rejects.toThrow();
    expect(await jobSqlite(file,"readonly-first","SELECT count(*) AS count FROM sqlite_master WHERE name='auxiliary_cost_reservations'"))
      .toEqual({count:0});
  });
});
