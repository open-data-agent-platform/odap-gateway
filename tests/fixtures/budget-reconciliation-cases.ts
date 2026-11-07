import { expect, it } from "vitest";
import { reserveAuxiliaryCost, settleAuxiliaryCost } from "../../lib/auxiliary-costs";
import { budgetReconciliationMaxRows, readBudgetReconciliation } from "../../lib/budget-reconciliation";
import type { ControlAccess } from "../../lib/control-storage";
import { settleIntentCost } from "../../lib/cost-settlement";
import type { D1PreparedStatement } from "../../lib/d1";
import { bill, receipt, reservation } from "./auxiliary-cost-cases";

export function budgetReconciliationCases(access: () => ControlAccess) {
  const run = (sql: string) => access().db.prepare(sql).run();
  const read = () => readBudgetReconciliation(access(),"b");
  const reserve = () => reserveAuxiliaryCost(access(),reservation);
  const settle = () => settleAuxiliaryCost(access(),reservation.id,bill);
  const empty = {recorded:0,settled:0,pending:0,recordedActualMicroUsd:"0",pendingReservedMicroUsd:"0"};
  it("separates SQL holds from the empty model and tool inventories",async () => {
    expect(await read()).toEqual({scope:"recorded-budget-accounting-only",tenantId:"t",budgetId:"b",
      consistent:true,countersConsistent:true,attributionConsistent:true,completeWorkflowCost:false,issuerAuthenticated:false,executionAuthorized:false,
      sql:{...empty,recorded:1,pending:1,pendingReservedMicroUsd:"20"},model:empty,tool:empty,
      ledger:{limitMicroUsd:"100",reservedMicroUsd:"20",spentMicroUsd:"0",overrunMicroUsd:"0"},
      totals:{recordedActualMicroUsd:"0",pendingReservedMicroUsd:"20",pendingComponents:1},
      difference:{reservedMicroUsd:"0",chargedMicroUsd:"0"},
      issues:{hasUnattributedRecords:false,invalidSqlReceipts:0,invalidAuxiliaryAudits:0,invalidAuxiliaryBills:0}});
  });
  it("reconciles mixed settled SQL/model and pending tool components",async () => {
    await reserve();await settle();
    await reserveAuxiliaryCost(access(),{...reservation,id:"tool-1",kind:"tool",operationRef:"fixture:tool",upperBoundMicroUsd:25});
    await settleIntentCost(access(),receipt,10);
    expect(await read()).toMatchObject({consistent:true,sql:{recordedActualMicroUsd:"10",pending:0},
      model:{recordedActualMicroUsd:"12",pending:0},tool:{pending:1,pendingReservedMicroUsd:"25"},
      totals:{recordedActualMicroUsd:"22",pendingReservedMicroUsd:"25",pendingComponents:1}});
  });
  it("keeps unknown costs distinct from an explicit final zero",async () => {
    await reserve();const pending=await read();
    await expect(settleAuxiliaryCost(access(),reservation.id,{...bill,status:"partial"})).rejects.toThrow();
    expect(await read()).toEqual(pending);
    await settleAuxiliaryCost(access(),reservation.id,{...bill,actualMicroUsd:0});
    expect(await read()).toMatchObject({consistent:true,model:{settled:1,pending:0,recordedActualMicroUsd:"0"},
      totals:{pendingReservedMicroUsd:"20",pendingComponents:1}});
  });
  it("retains historical overrun liability after another zero bill releases a hold",async () => {
    await reserve();await settleAuxiliaryCost(access(),reservation.id,{...bill,actualMicroUsd:150});
    await settleIntentCost(access(),receipt,0);
    expect(await read()).toMatchObject({consistent:true,ledger:{spentMicroUsd:"80",overrunMicroUsd:"70",reservedMicroUsd:"0"},
      totals:{recordedActualMicroUsd:"150",pendingReservedMicroUsd:"0"}});
  });
  it("does not duplicate costs after a replay",async () => {
    await reserve();await settle();const before=await read();await reserve();await settle();expect(await read()).toEqual(before);
  });
  it("sums individually safe final bills beyond the safe integer range exactly",async () => {
    await run(`UPDATE control_budgets SET limit_units=${Number.MAX_SAFE_INTEGER}`);
    await reserveAuxiliaryCost(access(),{...reservation,upperBoundMicroUsd:1});
    await settleIntentCost(access(),receipt,Number.MAX_SAFE_INTEGER);
    await settleAuxiliaryCost(access(),reservation.id,{...bill,actualMicroUsd:Number.MAX_SAFE_INTEGER});
    expect(await read()).toMatchObject({consistent:true,totals:{recordedActualMicroUsd:"18014398509481982"},
      ledger:{spentMicroUsd:"9007199254740991",overrunMicroUsd:"9007199254740991",reservedMicroUsd:"0"}});
  });
  it("counts an unsettled zero SQL hold as pending rather than final",async () => {
    await run("DROP TRIGGER intent_no_update");
    await run("UPDATE execution_intents SET reserved_units=0");
    await run("UPDATE control_budgets SET reserved_units=0");
    expect(await read()).toMatchObject({consistent:true,sql:{pending:1,settled:0,pendingReservedMicroUsd:"0"},
      totals:{pendingComponents:1,pendingReservedMicroUsd:"0"}});
  });
  it.each(["user","missing"])("denies a non-owner %s",async principalId => {
    await reserve();expect(await readBudgetReconciliation({...access(),principalId},"b")).toBeNull();
  });
  it.each(["active=0","role='reviewer'"])("checks current owner membership: %s",async update => {
    await reserve();await run(`UPDATE control_memberships SET ${update} WHERE tenant_id='t' AND principal_id='owner'`);
    expect(await read()).toBeNull();
  });
  it("still allows a current owner to inspect cost after requester revocation",async () => {
    await reserve();await run("UPDATE control_memberships SET active=0 WHERE principal_id='user'");
    expect(await read()).toMatchObject({consistent:true,totals:{pendingReservedMicroUsd:"50"}});
  });
  it("rechecks authority in the same statement instead of relying on preflight",async () => {
    const base=access();let reads=0;
    const wrap=(statement:D1PreparedStatement):D1PreparedStatement=>({...statement,
      bind:(...args)=>wrap(statement.bind(...args)),first:async column=>{
        reads++;await run("UPDATE control_memberships SET active=0 WHERE principal_id='owner'");
        return statement.first(column);
      }});
    expect(await readBudgetReconciliation({...base,db:{prepare:sql=>wrap(base.db.prepare(sql))}},"b")).toBeNull();
    expect(reads).toBe(1);
  });
  it("never mixes equal budget IDs or foreign-owner membership across tenants",async () => {
    await run("INSERT INTO control_tenants VALUES('other','Other')");
    await run("INSERT INTO control_memberships VALUES('other','owner','owner',1),('other','outsider','owner',1)");
    await run("INSERT INTO control_budgets(tenant_id,id,limit_units) VALUES('other','b',777)");
    await reserve();
    expect(await readBudgetReconciliation({...access(),tenantId:"other"},"b")).toMatchObject({consistent:true,
      ledger:{limitMicroUsd:"777"},sql:empty,model:empty,tool:empty});
    await run("INSERT INTO control_object_events(tenant_id,object_kind,object_id,actor) VALUES('other','auxiliary_cost_reserved','missing','owner')");
    expect(await read()).toMatchObject({consistent:true,issues:{hasUnattributedRecords:false}});
    expect(await readBudgetReconciliation({...access(),principalId:"outsider"},"b")).toBeNull();
    expect(await readBudgetReconciliation(access(),"B")).toBeNull();
    expect(await readBudgetReconciliation(access(),"b' OR 1=1 --")).toBeNull();
  });
  it("does not include another budget's holds or unexplained balance",async () => {
    await run("INSERT INTO control_budgets(tenant_id,id,limit_units,spent_units) VALUES('t','second',1000,7)");
    expect(await read()).toMatchObject({consistent:true,totals:{pendingReservedMicroUsd:"20",recordedActualMicroUsd:"0"}});
    expect(await readBudgetReconciliation(access(),"second")).toMatchObject({consistent:false,difference:{chargedMicroUsd:"-7"}});
  });
  it.each([
    ["reserved", "UPDATE control_budgets SET reserved_units=19", "1", "0"],
    ["spent", "UPDATE control_budgets SET spent_units=2", "0", "-2"],
    ["overrun", "UPDATE control_budgets SET overrun_units=1", "0", "-1"]
  ])("reports %s counter drift without silently repairing it",async (_kind,query,reserved,charged) => {
    await run(query);
    expect(await read()).toMatchObject({consistent:false,countersConsistent:false,attributionConsistent:true,
      difference:{reservedMicroUsd:reserved,chargedMicroUsd:charged}});
  });
  it.each(["reserved","settled"])("does not count missing %s audit as verified attribution",async kind => {
    await reserve();await settle();await run("DROP TRIGGER control_event_no_delete");
    await run(`DELETE FROM control_object_events WHERE object_kind='auxiliary_cost_${kind}'`);
    expect(await read()).toMatchObject({consistent:false,countersConsistent:true,attributionConsistent:false,
      issues:{invalidAuxiliaryAudits:1}});
  });
  it("rejects duplicate audit as an attribution failure even when totals balance",async () => {
    await reserve();await run(`INSERT INTO control_object_events(tenant_id,object_kind,object_id,actor,recorded_at)
      SELECT tenant_id,object_kind,object_id,actor,recorded_at FROM control_object_events WHERE object_kind='auxiliary_cost_reserved'`);
    expect(await read()).toMatchObject({consistent:false,issues:{invalidAuxiliaryAudits:1}});
  });
  it("does not accept a settlement audit without a final bill",async () => {
    await reserve();await run("INSERT INTO control_object_events(tenant_id,object_kind,object_id,actor) VALUES('t','auxiliary_cost_settled','model-1','owner')");
    expect(await read()).toMatchObject({consistent:false,model:{pending:1},issues:{invalidAuxiliaryAudits:1}});
  });
  it("reports unassignable tenant audit records instead of silently dropping them",async () => {
    await run("INSERT INTO control_object_events(tenant_id,object_kind,object_id,actor) VALUES('t','auxiliary_cost_reserved','missing','owner')");
    expect(await read()).toMatchObject({consistent:false,countersConsistent:true,issues:{hasUnattributedRecords:true}});
  });
  it("reports a changed bill operation binding with the recorded liability still visible",async () => {
    await reserve();await settle();await run("DROP TRIGGER auxiliary_settlement_no_update");
    await run("UPDATE auxiliary_cost_settlements SET operation_ref='fixture:wrong'");
    expect(await read()).toMatchObject({consistent:false,countersConsistent:true,model:{recordedActualMicroUsd:"12"},
      issues:{invalidAuxiliaryBills:1}});
  });
  it("checks the SQL settlement's terminal receipt link",async () => {
    await settleIntentCost(access(),receipt,10);await run("DROP TRIGGER receipt_immutable_update");
    await run("UPDATE evidence_receipts SET payload=json_set(payload,'$.intentId','other') WHERE id='sql-final'");
    expect(await read()).toMatchObject({consistent:false,countersConsistent:true,issues:{invalidSqlReceipts:1}});
  });
  it("uses exactly one read and leaves counters and audit rows unchanged",async () => {
    await reserve();const base=access();let reads=0;
    const query="SELECT reserved_units,spent_units,(SELECT count(*) FROM control_object_events) AS events FROM control_budgets";
    const before=await base.db.prepare(query).first();
    const wrapped={...base,db:{prepare:(sql:string)=>{reads++;expect(sql.trim()).toMatch(/^SELECT /);return base.db.prepare(sql);}}};
    expect(await readBudgetReconciliation(wrapped,"b")).toMatchObject({consistent:true});expect(reads).toBe(1);
    expect(await base.db.prepare(query).first()).toEqual(before);
  });
  it("does not truncate an over-limit component inventory",async () => {
    await run("UPDATE control_budgets SET limit_units=10000");
    await run(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<${budgetReconciliationMaxRows+1})
      INSERT INTO auxiliary_cost_reservations(tenant_id,id,intent_id,kind,operation_ref,operation_digest,reserved_units,actor)
      SELECT 't',printf('r-%04d',x),'i','tool',printf('fixture:%04d',x),'${reservation.operationDigest}',1,'owner' FROM n`);
    await expect(read()).rejects.toThrow("Invalid budget accounting snapshot");
  });
}
