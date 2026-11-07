import { expect, it } from "vitest";
import { exportAuxiliaryCostEvidence } from "../../lib/auxiliary-cost-evidence-export";
import { auxiliaryCostMaxComponents, verifyAuxiliaryCostEvidence } from "../../lib/auxiliary-cost-evidence";
import { reserveAuxiliaryCost, settleAuxiliaryCost } from "../../lib/auxiliary-costs";
import type { ControlAccess } from "../../lib/control-storage";
import { bill, reservation } from "./auxiliary-cost-cases";

export function auxiliaryExportCases(access: () => ControlAccess) {
  const run = (sql: string) => access().db.prepare(sql).run();
  const reserve = () => reserveAuxiliaryCost(access(),reservation);
  const settle = () => settleAuxiliaryCost(access(),reservation.id,bill);
  const snapshot = () => exportAuxiliaryCostEvidence(access(),"i");
  const verify = async () => {
    const bundle=await snapshot(); expect(bundle).not.toBeNull();
    return verifyAuxiliaryCostEvidence(bundle!.json,{tenantId:"t",intentId:"i"},bundle!.digest);
  };
  it("exports an empty inventory without claiming workflow cost completeness",async () => {
    expect(await verify()).toMatchObject({recordedComponents:0,settledActualMicroUsd:"0",completeWorkflowCost:false});
  });
  it("exports final model cost and pending tool capacity without including SQL holds",async () => {
    await reserve(); await settle();
    await reserveAuxiliaryCost(access(),{...reservation,id:"tool-1",kind:"tool",operationRef:"fixture:tool",upperBoundMicroUsd:25});
    expect(await verify()).toMatchObject({recordedComponents:2,settledComponents:1,pendingComponents:1,
      settledActualMicroUsd:"12",pendingReservedMicroUsd:"25",completeWorkflowCost:false});
    expect(await access().db.prepare("SELECT reserved_units,spent_units FROM control_budgets WHERE tenant_id='t' AND id='b'").first())
      .toEqual({reserved_units:45,spent_units:12});
  });
  it.each(["user","absent"])("does not expose records to %s",async principalId => {
    await reserve(); expect(await exportAuxiliaryCostEvidence({...access(),principalId},"i")).toBeNull();
  });
  it.each(["active=0","role='reader'"])("uses current owner membership: %s",async mutation => {
    await reserve(); await run(`UPDATE control_memberships SET ${mutation} WHERE tenant_id='t' AND principal_id='owner'`);
    expect(await snapshot()).toBeNull();
  });
  it("does not cross tenant bindings even for an owner of another tenant",async () => {
    await reserve();
    await run("INSERT INTO control_tenants VALUES('other','Other')");
    await run("INSERT INTO control_memberships VALUES('other','owner','owner',1)");
    expect(await exportAuxiliaryCostEvidence({...access(),tenantId:"other"},"i")).toBeNull();
    expect(await exportAuxiliaryCostEvidence(access(),"missing")).toBeNull();
  });
  it("keeps older pending evidence immutable after a late bill",async () => {
    await reserve(); const before=await snapshot(); await settle(); const after=await snapshot();
    expect(before!.digest).not.toBe(after!.digest);
    expect(await verifyAuxiliaryCostEvidence(before!.json,{tenantId:"t",intentId:"i"},before!.digest))
      .toMatchObject({pendingComponents:1,pendingReservedMicroUsd:"30",settledActualMicroUsd:"0"});
    await expect(verifyAuxiliaryCostEvidence(after!.json,{tenantId:"t",intentId:"i"},before!.digest)).rejects.toThrow("checksum");
  });
  it("allows current owners to retain evidence after requester revocation",async () => {
    await reserve(); await settle(); await run("UPDATE control_memberships SET active=0 WHERE tenant_id='t' AND principal_id='user'");
    expect(await verify()).toMatchObject({settledActualMicroUsd:"12"});
  });
  it("rejects duplicate component audit rows",async () => {
    await reserve();
    await run(`INSERT INTO control_object_events(tenant_id,object_kind,object_id,actor,recorded_at)
      SELECT tenant_id,object_kind,object_id,actor,recorded_at FROM control_object_events WHERE object_kind='auxiliary_cost_reserved'`);
    await expect(snapshot()).rejects.toThrow("duplicate component audit");
  });
  it.each(["reserved","settled"])("rejects a corrupted snapshot with missing %s audit",async kind => {
    await reserve(); await settle();
    await run("DROP TRIGGER control_event_no_delete");
    await run(`DELETE FROM control_object_events WHERE object_kind='auxiliary_cost_${kind}'`);
    await expect(snapshot()).rejects.toThrow("component audit");
  });
  it("refuses a settlement event without a corresponding final bill",async () => {
    await reserve();
    await run("INSERT INTO control_object_events(tenant_id,object_kind,object_id,actor) VALUES('t','auxiliary_cost_settled','model-1','owner')");
    await expect(snapshot()).rejects.toThrow("Unexpected settlement audit");
  });
  it("uses one read-only statement and does not change budget or event state",async () => {
    await reserve(); let reads=0;
    const base=access(), before=await base.db.prepare("SELECT reserved_units,spent_units,(SELECT count(*) FROM control_object_events) AS events FROM control_budgets").first();
    const wrapped={...base,db:{prepare:(sql: string) => {reads++; expect(sql.trimStart()).toMatch(/^SELECT /);return base.db.prepare(sql);}}};
    expect(await exportAuxiliaryCostEvidence(wrapped,"i")).not.toBeNull(); expect(reads).toBe(1);
    expect(await base.db.prepare("SELECT reserved_units,spent_units,(SELECT count(*) FROM control_object_events) AS events FROM control_budgets").first()).toEqual(before);
  });
  it("rejects oversized inventories instead of truncating pending components",async () => {
    await run("UPDATE control_budgets SET limit_units=10000");
    await run(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<${auxiliaryCostMaxComponents+1})
      INSERT INTO auxiliary_cost_reservations(tenant_id,id,intent_id,kind,operation_ref,operation_digest,reserved_units,actor)
      SELECT 't',printf('model-%04d',n),'i','model',printf('fixture:operation-%04d',n),'${reservation.operationDigest}',1,'owner' FROM seq`);
    await expect(snapshot()).rejects.toThrow("profile");
  });
}
