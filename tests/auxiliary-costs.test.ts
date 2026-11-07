import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reserveAuxiliaryCost, settleAuxiliaryCost } from "../lib/auxiliary-costs";
import { jobSqlite, jobTransactionalDatabase } from "./fixtures/job-sqlite";
import { auxiliaryCostCases, bill, reservation } from "./fixtures/auxiliary-cost-cases";

let dir: string, file: string;
const access = () => ({db:jobTransactionalDatabase(() => file),tenantId:"t",principalId:"owner"});
describe("auxiliary cost accounting on SQLite",() => {
  beforeEach(async () => {dir = await mkdtemp(join(tmpdir(),"odap-auxiliary-")); file = join(dir,"ledger.db"); await jobSqlite(file,"setup");});
  afterEach(async () => {await rm(dir,{recursive:true,force:true});});
  auxiliaryCostCases(access);
  it.each([-1,0.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1,"1",null])("rejects malformed micro-USD amounts: %s",async amount => {
    await expect(reserveAuxiliaryCost(access(),{...reservation,upperBoundMicroUsd:amount as number})).rejects.toThrow("Invalid");
    await expect(settleAuxiliaryCost(access(),"model-1",{...bill,actualMicroUsd:amount})).rejects.toThrow("Final");
  });
  it.each([{id:""},{id:"a\u0000"},{operationRef:"bad ref"},{kind:"sql"},{operationDigest:"sha256:no"},{upperBoundMicroUsd:0}])("rejects malformed reservation: %j",async change => {
    await expect(reserveAuxiliaryCost(access(),{...reservation,...change} as typeof reservation)).rejects.toThrow("Invalid");
  });
  it("upgrades populated v32 without changing prior holds or inventing bills",async () => {
    file = join(dir,"old.db"); await jobSqlite(file,"setup-v32");
    const snapshot = () => jobSqlite(file,"readonly-first","SELECT * FROM control_budgets");
    const before = await snapshot(); await jobSqlite(file,"apply-auxiliary-costs");
    expect(await snapshot()).toEqual(before);
    expect(await jobSqlite(file,"readonly-first","SELECT count(*) AS count FROM auxiliary_cost_reservations")).toEqual({count:0});
    await reserveAuxiliaryCost(access(),reservation);
    expect(await snapshot()).toMatchObject({reserved_units:50});
  });
});
