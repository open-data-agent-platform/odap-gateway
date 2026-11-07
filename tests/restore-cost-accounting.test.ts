import { execFile } from "node:child_process";
import { copyFile, link, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { reserveAuxiliaryCost, settleAuxiliaryCost } from "../lib/auxiliary-costs";
import { exportAuxiliaryCostEvidence } from "../lib/auxiliary-cost-evidence-export";
import { settleIntentCost } from "../lib/cost-settlement";
import { bill, receipt, reservation } from "./fixtures/auxiliary-cost-cases";
import { jobDatabase, jobSqlite, jobTransactionalDatabase } from "./fixtures/job-sqlite";

const exec = promisify(execFile);
const python = process.env.ODAP_TEST_PYTHON || (process.platform === "win32" ? "python" : "python3");
let dir: string;
const file = (name: string) => join(dir,name + ".sqlite");
const access = (name: string) => ({db:jobTransactionalDatabase(() => file(name)),tenantId:"t",principalId:"owner"});
const sql = (name: string, query: string) => jobSqlite(file(name),"run",query);
async function compare(restored: string, reference: string, code = 0, tenant = "t") {
  const args = ["-B","scripts/check-restore-costs.py","--restored",file(restored),"--reference",file(reference),"--tenant",tenant];
  const result = await exec(python,args).then(r => ({...r,code:0}),
    (e: {code:number;stdout:string;stderr:string}) => e);
  expect(result.code).toBe(code);
  if (code === 2) {
    expect(result.stdout).toBe("");
    expect(result.stderr.replace(/\r\n/g,"\n")).toBe("No comparison: unusable standalone snapshots, tenant or accounting bindings.\n");
    return null;
  }
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout);
}
async function changed(name: string, queries: string[], source = "final") {
  await copyFile(file(source),file(name));
  for (const query of queries) await sql(name,query);
}
async function corrupted(name: string, queries: string[], source = "final") {
  await copyFile(file(source),file(name));
  await exec(python,["-B","-c",`import json,sqlite3,sys
with sqlite3.connect(sys.argv[1]) as db:
    db.execute('PRAGMA ignore_check_constraints=ON')
    for query in json.loads(sys.argv[2]):
        db.execute(query)
`,file(name),JSON.stringify(queries)]);
}

describe("detached SQL and auxiliary cost restore comparison",() => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(),"odap-cost-restore-"));
    await jobSqlite(file("live"),"setup");
    await sql("live","INSERT INTO control_tenants VALUES('peer','Peer')");
    await sql("live","INSERT INTO control_budgets VALUES('peer','b',100,0,17,0)");
    const save = (phase: string) => jobSqlite(file("live"),"run","VACUUM INTO ?",[file(phase)]);
    await save("sql-hold");
    await reserveAuxiliaryCost(access("live"),reservation);
    await reserveAuxiliaryCost(access("live"),{...reservation,id:"tool-1",kind:"tool",operationRef:"fixture:tool",upperBoundMicroUsd:20});
    await save("pending");
    await settleIntentCost(access("live"),receipt,10);
    await save("sql-settled");
    await settleAuxiliaryCost(access("live"),reservation.id,bill);
    await save("model-settled");
    await settleAuxiliaryCost(access("live"),"tool-1",{...bill,operationRef:"fixture:tool",reference:"fixture:tool-bill",actualMicroUsd:150});
    await save("final");
  },30_000);
  afterAll(async () => {if (dir) await rm(dir,{recursive:true,force:true});});

  it.each([
    ["sql-hold","20","0","0",0], ["pending","20","50","0",2],
    ["sql-settled","0","50","10",2], ["model-settled","0","20","22",1],
    ["final","0","0","172",0]
  ])("recovers %s without changing snapshot bytes or inventing final costs",async (phase,sqlHold,auxHold,actual,pending) => {
    const name = phase + "-restored";
    await copyFile(file(phase as string),file(name));
    const paths = [file(phase as string),file(name)];
    const before = await Promise.all(paths.map(p => readFile(p)));
    const directory = await readdir(dir);
    const report = await compare(name,phase as string);
    expect(report).toMatchObject({costComparison:"equal",countersConsistent:true,
      scope:"recorded-tenant-accounting-only",issuerAuthenticated:false,completeWorkflowCost:false,
      retryAuthorized:false,servingAuthorized:false,restored:{inconsistentBudgets:0,
        pendingSqlMicroUsd:sqlHold,pendingAuxiliaryMicroUsd:auxHold,recordedActualMicroUsd:actual,pendingAuxiliaryComponents:pending}});
    expect(report.restored).toEqual(report.reference);
    const exported = async (path: string) => exportAuxiliaryCostEvidence({
      db:jobDatabase(() => path,"readonly"),tenantId:"t",principalId:"owner"},"i");
    expect(await exported(paths[0])).toEqual(await exported(paths[1]));
    for (let i=0;i<paths.length;i++) expect((await readFile(paths[i])).equals(before[i])).toBe(true);
    expect(await readdir(dir)).toEqual(directory);
  });

  it("detects lost auxiliary holds even when each snapshot has consistent counters",async () => {
    expect(await compare("sql-hold","pending",1)).toMatchObject({countersConsistent:true,
      differences:{auxiliary_cost_reservations:{referenceOnly:2,restoredOnly:0,changed:0},
        control_budgets:{changed:1},auxiliary_audit:{referenceOnly:2}},
      restored:{pendingAuxiliaryMicroUsd:"0"},reference:{pendingAuxiliaryMicroUsd:"50"}});
    expect(await compare("pending","sql-hold",1)).toMatchObject({differences:{auxiliary_cost_reservations:{restoredOnly:2,referenceOnly:0}}});
  });
  it("detects late SQL and component bills without authorizing any retry",async () => {
    expect(await compare("pending","sql-settled",1)).toMatchObject({differences:{cost_settlements:{referenceOnly:1}},
      restored:{pendingSqlIntents:1},reference:{pendingSqlIntents:0},retryAuthorized:false});
    expect(await compare("model-settled","final",1)).toMatchObject({differences:{auxiliary_cost_settlements:{referenceOnly:1}},
      restored:{pendingAuxiliaryMicroUsd:"20"},reference:{auxiliaryActualMicroUsd:"162"}});
  });
  it("preserves the historical overrun split rather than recalculating it from free capacity",async () => {
    await changed("historical-overrun",["UPDATE control_budgets SET spent_units=80,overrun_units=92 WHERE tenant_id='t'"]);
    await copyFile(file("historical-overrun"),file("historical-overrun-copy"));
    expect(await compare("historical-overrun","historical-overrun-copy")).toMatchObject({countersConsistent:true,
      restored:{recordedActualMicroUsd:"172"}});
  });
  it("does not hide changed operation attribution behind unchanged totals",async () => {
    await changed("changed-digest",["DROP TRIGGER auxiliary_reservation_no_update",
      `UPDATE auxiliary_cost_reservations SET operation_digest='sha256:${"b".repeat(64)}' WHERE id='model-1'`]);
    expect(await compare("changed-digest","final",1)).toMatchObject({countersConsistent:true,
      differences:{auxiliary_cost_reservations:{changed:1,referenceOnly:0,restoredOnly:0}}});
  });
  it.each([
    ["reserved", "UPDATE control_budgets SET reserved_units=19 WHERE tenant_id='t'", "pending"],
    ["spent", "UPDATE control_budgets SET spent_units=99 WHERE tenant_id='t'", "final"],
    ["overrun", "UPDATE control_budgets SET overrun_units=71 WHERE tenant_id='t'", "final"]
  ])("fails equal snapshots with unexplained %s counters",async (kind,query,source) => {
    const name = "counter-" + kind;
    await changed(name,[query],source);
    await copyFile(file(name),file(name + "-copy"));
    expect(await compare(name,name + "-copy",1)).toMatchObject({costComparison:"equal",countersConsistent:false,
      restored:{inconsistentBudgets:1},reference:{inconsistentBudgets:1},servingAuthorized:false});
  });
  it("limits comparison to the exact tenant without case folding or SQL interpolation",async () => {
    await changed("peer-changed",["UPDATE control_budgets SET spent_units=42 WHERE tenant_id='peer'"]);
    expect(await compare("final","peer-changed")).toMatchObject({costComparison:"equal",countersConsistent:true});
    for (const tenant of ["T","missing","t' OR 1=1 --"," "]) await compare("final","peer-changed",2,tenant);
    expect(await compare("final","peer-changed",1,"peer")).toMatchObject({countersConsistent:false,
      restored:{sqlIntents:0,inconsistentBudgets:1}});
  });
  it("reports an existing empty tenant without claiming complete zero-cost coverage",async () => {
    await changed("empty",["INSERT INTO control_tenants VALUES('empty','Empty')"]);
    await copyFile(file("empty"),file("empty-copy"));
    expect(await compare("empty","empty-copy",0,"empty")).toMatchObject({completeWorkflowCost:false,
      restored:{budgets:0,sqlIntents:0,recordedActualMicroUsd:"0"}});
  });
  it.each([
    ["audit-missing",["DROP TRIGGER control_event_no_delete","DELETE FROM control_object_events WHERE object_kind='auxiliary_cost_settled'"]],
    ["audit-duplicate",["INSERT INTO control_object_events(tenant_id,object_kind,object_id,actor,recorded_at) SELECT tenant_id,object_kind,object_id,actor,recorded_at FROM control_object_events WHERE object_kind='auxiliary_cost_reserved'"]],
    ["audit-actor",["DROP TRIGGER control_event_no_update","UPDATE control_object_events SET actor='changed' WHERE object_kind='auxiliary_cost_settled'"]],
    ["audit-order",["DROP TRIGGER control_event_no_update","UPDATE control_object_events SET sequence=100000 WHERE object_kind='auxiliary_cost_reserved' AND object_id='model-1'"]],
    ["bill-binding",["DROP TRIGGER auxiliary_settlement_no_update","UPDATE auxiliary_cost_settlements SET operation_ref='fixture:wrong' WHERE reservation_id='model-1'"]]
  ])("refuses broken attribution rather than comparing %s as empty",async (name,queries) => {
    await changed(name,queries as string[]);
    await compare(name,"final",2);
  });
  it.each([
    ["intent-budget",["DROP TRIGGER intent_no_update","UPDATE execution_intents SET budget_id='missing'"]],
    ["sql-orphan",["DROP TRIGGER settlement_no_update","UPDATE cost_settlements SET intent_id='missing'"]],
    ["sql-receipt",["DROP TRIGGER settlement_no_update","UPDATE cost_settlements SET receipt_id='missing'"]],
    ["component-orphan",["DROP TRIGGER auxiliary_reservation_no_update","UPDATE auxiliary_cost_reservations SET intent_id='missing'"]],
    ["negative-counter",["UPDATE control_budgets SET overrun_units=-1 WHERE tenant_id='t'"]],
    ["fractional-counter",["UPDATE control_budgets SET overrun_units=0.5 WHERE tenant_id='t'"]],
    ["unsafe-counter",["UPDATE control_budgets SET overrun_units=9007199254740992 WHERE tenant_id='t'"]]
  ])("rejects a deliberately corrupted %s snapshot with private generic diagnostics",async (name,queries) => {
    await corrupted(name,queries as string[]);
    await compare(name,"final",2);
  });
  it("sums independent budgets beyond the JavaScript safe-integer range exactly",async () => {
    await jobSqlite(file("large"),"setup");
    const db = access("large").db;
    await db.batch!([
      "UPDATE control_budgets SET limit_units=9007199254740991 WHERE tenant_id='t'",
      "INSERT INTO control_budgets(tenant_id,id,limit_units) VALUES('t','b2',9007199254740991)",
      `INSERT INTO approval_contracts(tenant_id,id,release_id,payload,created_by)
        SELECT tenant_id,'c2',release_id,json_set(payload,'$.id','c2','$.reservationId','s2'),created_by FROM approval_contracts WHERE id='c'`,
      `INSERT INTO execution_intents SELECT tenant_id,'i2','c2','b2','s2',principal_id,action_digest,20,created_at FROM execution_intents WHERE id='i'`
    ].map(query => db.prepare(query)));
    await settleIntentCost(access("large"),receipt,Number.MAX_SAFE_INTEGER);
    await settleIntentCost(access("large"),{...receipt,id:"sql-final2",intentId:"i2",contractId:"c2"},Number.MAX_SAFE_INTEGER);
    await copyFile(file("large"),file("large-copy"));
    expect(await compare("large","large-copy")).toMatchObject({countersConsistent:true,
      restored:{sqlActualMicroUsd:"18014398509481982",recordedActualMicroUsd:"18014398509481982"}});
  });
  it("distinguishes an explicit zero bill from a still-pending component",async () => {
    await copyFile(file("pending"),file("zero-bill"));
    await settleAuxiliaryCost(access("zero-bill"),reservation.id,{...bill,actualMicroUsd:0});
    await copyFile(file("zero-bill"),file("zero-bill-copy"));
    expect(await compare("zero-bill","zero-bill-copy")).toMatchObject({countersConsistent:true,
      restored:{auxiliarySettlements:1,pendingAuxiliaryComponents:1,pendingAuxiliaryMicroUsd:"20",auxiliaryActualMicroUsd:"0"}});
  });
  it("keeps a zero-amount SQL reservation pending until its bill exists",async () => {
    await changed("zero-hold",["DROP TRIGGER intent_no_update","UPDATE execution_intents SET reserved_units=0",
      "UPDATE control_budgets SET reserved_units=50 WHERE tenant_id='t'"],"pending");
    await copyFile(file("zero-hold"),file("zero-hold-copy"));
    expect(await compare("zero-hold","zero-hold-copy")).toMatchObject({countersConsistent:true,
      restored:{pendingSqlIntents:1,pendingSqlMicroUsd:"0",sqlSettlements:0}});
  });
  it("rejects old-schema, same-file, linked-file, missing and journal-dependent inputs",async () => {
    await jobSqlite(file("v32"),"setup-v32");
    await compare("v32","final",2);
    await compare("final","final",2);
    await link(file("final"),file("hard-link"));
    await compare("final","hard-link",2);
    await compare("missing","final",2);
    expect(await readdir(dir)).not.toContain("missing.sqlite");
    for (const suffix of ["-wal","-shm","-journal"]) {
      const name = "sidecar" + suffix;
      await copyFile(file("final"),file(name));
      await writeFile(file(name) + suffix,"synthetic pending journal");
      await compare(name,"final",2);
    }
    await copyFile(file("final"),file("wal-mode"));
    await jobSqlite(file("wal-mode"),"first","PRAGMA journal_mode=WAL");
    await compare("wal-mode","final",2);
  });
  it("fails on a bounded inventory overflow instead of silently truncating",async () => {
    await changed("too-many",[`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<10000)
      INSERT INTO control_budgets(tenant_id,id,limit_units) SELECT 't','budget-'||x,0 FROM n`]);
    await compare("too-many","final",2);
  });
  it("has a nonzero usage exit when required scope is absent",async () => {
    await expect(exec(python,["-B","scripts/check-restore-costs.py","--restored",file("final")])).rejects.toMatchObject({code:2,stdout:""});
  });
});
