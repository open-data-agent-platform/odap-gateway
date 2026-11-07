import { expect, it } from "vitest";
import { readAuxiliaryCost, reserveAuxiliaryCost, settleAuxiliaryCost } from "../../lib/auxiliary-costs";
import type { ControlAccess } from "../../lib/control-storage";
import { settleIntentCost } from "../../lib/cost-settlement";
import { admitExecutionIntent } from "../../lib/execution-intents";
import type { D1PreparedStatement } from "../../lib/d1";

export const reservation = { id: "model-1", intentId: "i", kind: "model" as const,
  operationRef: "fixture:operation-1", operationDigest: "sha256:"+"a".repeat(64), upperBoundMicroUsd: 30 };
export const bill = { status: "final", unit: "micro-USD", operationRef: reservation.operationRef,
  reference: "fixture:bill-1", actualMicroUsd: 12 };
export const receipt = { schemaVersion: "0.1", id: "sql-final", tenantId: "t", intentId: "i", contractId: "c",
  semanticReleaseId: "r", outcome: "succeeded", reason: "synthetic job", recordedAt: "2026-11-07T00:00:00.000Z" };

export function auxiliaryCostCases(access: () => ControlAccess) {
  const reserve = (input = reservation, a = access()) => reserveAuxiliaryCost(a,input);
  const settle = (input: unknown = bill, a = access()) => settleAuxiliaryCost(a,"model-1",input);
  const run = (sql: string) => access().db.prepare(sql).run();
  const ledger = () => access().db.prepare(`SELECT reserved_units,spent_units,overrun_units,
    (SELECT count(*) FROM auxiliary_cost_reservations) AS reservations,
    (SELECT count(*) FROM auxiliary_cost_settlements) AS settlements,
    (SELECT count(*) FROM control_object_events WHERE object_kind LIKE 'auxiliary_cost_%') AS events
    FROM control_budgets WHERE tenant_id='t' AND id='b'`).first();

  it("shares capacity with SQL and settles only the auxiliary hold",async () => {
    expect(await reserve()).toEqual({id:"model-1",replay:false});
    expect(await ledger()).toEqual({reserved_units:50,spent_units:0,overrun_units:0,reservations:1,settlements:0,events:1});
    expect(await settle()).toEqual({id:"model-1",settled:true,replay:false});
    expect(await ledger()).toEqual({reserved_units:20,spent_units:12,overrun_units:0,reservations:1,settlements:1,events:2});
    expect(await readAuxiliaryCost(access(),"model-1")).toMatchObject({settled:true,actualMicroUsd:12,billingRef:bill.reference});
  });
  it("SQL settlement preserves pending model and tool holds",async () => {
    await reserve();
    await reserveAuxiliaryCost(access(),{...reservation,id:"tool-1",kind:"tool",operationRef:"fixture:tool",upperBoundMicroUsd:25});
    await settleIntentCost(access(),receipt,10);
    expect(await ledger()).toMatchObject({reserved_units:55,spent_units:10});
    await settle();
    expect(await ledger()).toMatchObject({reserved_units:25,spent_units:22});
    expect(await readAuxiliaryCost(access(),"tool-1")).toMatchObject({settled:false,actualMicroUsd:null});
  });
  it("auxiliary settlement preserves SQL capacity until its own bill",async () => {
    await reserve(); await settle();
    await settleIntentCost(access(),receipt,15);
    expect(await ledger()).toMatchObject({reserved_units:0,spent_units:27});
  });
  it("replays identical reservations and bills without double accounting",async () => {
    await reserve();
    expect(await reserve()).toEqual({id:"model-1",replay:true});
    await settle();
    const before = await ledger();
    expect(await settle()).toMatchObject({replay:true});
    expect(await reserve()).toMatchObject({replay:true});
    expect(await ledger()).toEqual(before);
  });
  it.each([
    {intentId:"other"},{kind:"tool" as const},{operationRef:"other"},
    {operationDigest:"sha256:"+"b".repeat(64)},{upperBoundMicroUsd:31}
  ])("rejects reuse with changed reservation binding: %j",async change => {
    await reserve(); const before = await ledger();
    await expect(reserveAuxiliaryCost(access(),{...reservation,...change})).rejects.toThrow("conflict");
    expect(await ledger()).toEqual(before);
  });
  it("does not reserve the same operation using a new ID",async () => {
    await reserve(); const before = await ledger();
    await expect(reserve({...reservation,id:"duplicate"})).rejects.toThrow();
    expect(await ledger()).toEqual(before);
  });
  it("rejects an amount that would overspend shared capacity",async () => {
    const before = await ledger();
    await expect(reserve({...reservation,upperBoundMicroUsd:81})).rejects.toThrow();
    expect(await ledger()).toEqual(before);
    await reserve({...reservation,upperBoundMicroUsd:80});
    expect(await ledger()).toMatchObject({reserved_units:100});
  });
  it("serializes competing reservations against one remaining balance",async () => {
    const attempts = await Promise.allSettled([reserve({...reservation,upperBoundMicroUsd:50}),
      reserve({...reservation,id:"model-2",operationRef:"fixture:operation-2",upperBoundMicroUsd:50})]);
    expect(attempts.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(await ledger()).toMatchObject({reserved_units:70,reservations:1,events:1});
  });
  it("concurrent duplicate reservations have one hold, recoverable by retry",async () => {
    const attempts = await Promise.allSettled([reserve(),reserve()]);
    expect(attempts.some(r => r.status === "fulfilled")).toBe(true);
    expect(await reserve()).toMatchObject({replay:true});
    expect(await ledger()).toMatchObject({reserved_units:50,reservations:1,events:1});
  });
  it("concurrent bills release a hold exactly once",async () => {
    await reserve();
    const attempts = await Promise.allSettled([settle(),settle()]);
    expect(attempts.some(r => r.status === "fulfilled")).toBe(true);
    expect(await settle()).toMatchObject({replay:true});
    expect(await ledger()).toMatchObject({reserved_units:20,spent_units:12,settlements:1,events:2});
  });
  it.each([null,{}, {...bill,status:"partial"},{...bill,status:"cancelled"},{...bill,status:"timeout"},
    {...bill,actualMicroUsd:null},{...bill,unit:"USD"}])("keeps uncertain cost reserved: %j",async evidence => {
    await reserve(); const before = await ledger();
    await expect(settle(evidence)).rejects.toThrow("Final auxiliary bill required");
    expect(await ledger()).toEqual(before);
    expect(await readAuxiliaryCost(access(),"model-1")).toMatchObject({settled:false,actualMicroUsd:null,billingRef:null});
  });
  it("accepts an explicit final zero bill without refunding SQL",async () => {
    await reserve(); await settle({...bill,actualMicroUsd:0});
    expect(await ledger()).toMatchObject({reserved_units:20,spent_units:0,settlements:1});
  });
  it.each([{actualMicroUsd:13},{reference:"fixture:changed"},{operationRef:"fixture:other"}])("refuses a changed final bill: %j",async change => {
    await reserve(); await settle(); const before = await ledger();
    await expect(settle({...bill,...change})).rejects.toThrow();
    expect(await ledger()).toEqual(before);
  });
  it("cannot use the same billing reference for two operations",async () => {
    await reserve(); await settle();
    await reserve({...reservation,id:"model-2",operationRef:"fixture:operation-2"});
    const before = await ledger();
    await expect(settleAuxiliaryCost(access(),"model-2",{...bill,operationRef:"fixture:operation-2"})).rejects.toThrow();
    expect(await ledger()).toEqual(before);
  });
  it("refuses foreign owner authority and foreign intent bindings",async () => {
    await run("INSERT INTO control_tenants VALUES('other','Other')");
    await run("INSERT INTO control_memberships VALUES('other','outsider','owner',1)");
    const before = await ledger();
    await expect(reserve(reservation,{...access(),principalId:"outsider"})).rejects.toThrow();
    await expect(reserve(reservation,{...access(),tenantId:"other",principalId:"outsider"})).rejects.toThrow();
    await expect(reserve({...reservation,intentId:"missing"})).rejects.toThrow();
    expect(await ledger()).toEqual(before);
  });
  it.each(["UPDATE control_memberships SET active=0 WHERE principal_id='owner'",
    "UPDATE control_memberships SET role='reader' WHERE principal_id='owner'"])("checks current authority for reads, retries and settlement: %s",async change => {
    await reserve(); await run(change); const before = await ledger();
    await expect(reserve()).rejects.toThrow();
    await expect(settle()).rejects.toThrow("unavailable");
    await expect(readAuxiliaryCost(access(),"model-1")).rejects.toThrow("unavailable");
    await expect(run(`INSERT INTO auxiliary_cost_settlements VALUES('t','model-1','fixture:operation-1','fixture:bill',0,'owner','now')`)).rejects.toThrow();
    expect(await ledger()).toEqual(before);
  });
  it("late accounting remains possible after requester revocation",async () => {
    await reserve(); await run("UPDATE control_memberships SET active=0 WHERE principal_id='user'");
    await settle();
    expect(await ledger()).toMatchObject({reserved_units:20,spent_units:12});
  });
  it("retains full overrun liability and freezes SQL and auxiliary admission",async () => {
    await reserve(); await settle({...bill,actualMicroUsd:150});
    expect(await ledger()).toMatchObject({reserved_units:20,spent_units:80,overrun_units:70});
    expect(await readAuxiliaryCost(access(),"model-1")).toMatchObject({actualMicroUsd:150});
    await expect(reserve({...reservation,id:"model-2",operationRef:"fixture:2",upperBoundMicroUsd:1})).rejects.toThrow();
    await run(`INSERT INTO approval_contracts(tenant_id,id,release_id,payload,created_by)
      SELECT tenant_id,'c2',release_id,json_set(payload,'$.id','c2','$.reservationId','s2'),'owner' FROM approval_contracts WHERE id='c'`);
    await expect(admitExecutionIntent({...access(),principalId:"user"},{id:"i2",contractId:"c2",budgetId:"b",reservationId:"s2",
      actionDigest:"digest",reservedUnits:1})).rejects.toThrow(/overrun|budget/);
    await settleIntentCost(access(),receipt,0);
    expect(await ledger()).toMatchObject({reserved_units:0,spent_units:80,overrun_units:70});
  });
  it("rolls back safe-integer overflow without losing the pending hold",async () => {
    await reserve(); await run("UPDATE control_budgets SET overrun_units=9007199254740991");
    const before = await ledger();
    await expect(settle({...bill,actualMicroUsd:100})).rejects.toThrow();
    expect(await ledger()).toEqual(before);
  });
  it.each(["auxiliary_cost_reservations","auxiliary_cost_settlements"])("protects immutable %s from update/delete/replace",async table => {
    await reserve(); await settle(); const before = await ledger();
    for (const sql of [`UPDATE ${table} SET actor='owner'`,`DELETE FROM ${table}`,`INSERT OR REPLACE INTO ${table} SELECT * FROM ${table}`]) {
      await expect(run(sql)).rejects.toThrow(/immutable/);
    }
    expect(await ledger()).toEqual(before);
  });
  it.each(["ABORT","IGNORE"])("rolls back a missing reservation audit (%s)",async mode => {
    await run(`CREATE TRIGGER failed_write BEFORE INSERT ON control_object_events WHEN NEW.object_kind='auxiliary_cost_reserved'
      BEGIN SELECT RAISE(${mode}${mode === "ABORT" ? ",'synthetic failure'" : ""}); END`);
    const before = await ledger(); await expect(reserve()).rejects.toThrow(); expect(await ledger()).toEqual(before);
  });
  it.each(["ABORT","IGNORE"])("rolls back a missing settlement audit (%s)",async mode => {
    await reserve();
    await run(`CREATE TRIGGER failed_write BEFORE INSERT ON control_object_events WHEN NEW.object_kind='auxiliary_cost_settled'
      BEGIN SELECT RAISE(${mode}${mode === "ABORT" ? ",'synthetic failure'" : ""}); END`);
    const before = await ledger(); await expect(settle()).rejects.toThrow(); expect(await ledger()).toEqual(before);
  });
  it.each([false,true])("detects an ignored root insert (settlement=%s)",async settlement => {
    if (settlement) await reserve();
    await run(`CREATE TRIGGER failed_write BEFORE INSERT ON auxiliary_cost_${settlement ? "settlements" : "reservations"}
      BEGIN SELECT RAISE(IGNORE); END`);
    const before = await ledger();
    await expect(settlement ? settle() : reserve()).rejects.toThrow();
    expect(await ledger()).toEqual(before);
  });
  it.each([false,true])("rechecks owner authority at the write (settlement=%s)",async settlement => {
    if (settlement) await reserve();
    const base = access();
    const wrap = (statement: D1PreparedStatement): D1PreparedStatement => ({...statement,
      bind: (...args) => wrap(statement.bind(...args)), first: column => statement.first(column),
      all: async () => {
        await run("UPDATE control_memberships SET active=0 WHERE principal_id='owner'");
        return statement.all();
      }
    });
    const racing = {...base,db:{prepare:(sql: string) => wrap(base.db.prepare(sql))}};
    const before = await ledger();
    await expect(settlement ? settle(bill,racing) : reserve(reservation,racing)).rejects.toThrow();
    expect(await ledger()).toEqual(before);
  });
  it.each([false,true])("recovers a lost write acknowledgement without repeating accounting (settlement=%s)",async settlement => {
    if (settlement) await reserve();
    const base = access();
    const wrap = (statement: D1PreparedStatement): D1PreparedStatement => ({...statement,
      bind: (...args) => wrap(statement.bind(...args)), first: column => statement.first(column),
      all: async () => {await statement.all(); throw new Error("Synthetic lost acknowledgement");}
    });
    const lost = {...base,db:{prepare:(sql: string) => wrap(base.db.prepare(sql))}};
    await expect(settlement ? settle(bill,lost) : reserve(reservation,lost)).rejects.toThrow("Synthetic lost acknowledgement");
    const before = await ledger();
    expect(await (settlement ? settle() : reserve())).toMatchObject({replay:true});
    expect(await ledger()).toEqual(before);
  });
  it.each([false,true])("rolls back ignored budget updates (settlement=%s)",async settlement => {
    if (settlement) await reserve();
    await run("CREATE TRIGGER failed_write BEFORE UPDATE ON control_budgets BEGIN SELECT RAISE(IGNORE); END");
    const before = await ledger();
    await expect(settlement ? settle() : reserve()).rejects.toThrow();
    expect(await ledger()).toEqual(before);
  });
  it.each(["-1","0","1.5","9007199254740992","'not-units'"])("rejects invalid direct SQL reservation units: %s",async amount => {
    const before = await ledger();
    await expect(run(`INSERT INTO auxiliary_cost_reservations(tenant_id,id,intent_id,kind,operation_ref,operation_digest,reserved_units,actor)
      VALUES('t','model-1','i','model','fixture:operation-1','${reservation.operationDigest}',${amount},'owner')`)).rejects.toThrow();
    expect(await ledger()).toEqual(before);
  });
  it("rejects embedded NUL even through direct SQL",async () => {
    const before = await ledger();
    await expect(run(`INSERT INTO auxiliary_cost_reservations(tenant_id,id,intent_id,kind,operation_ref,operation_digest,reserved_units,actor)
      VALUES('t','model-1'||char(0),'i','model','fixture:operation-1','${reservation.operationDigest}',30,'owner')`)).rejects.toThrow();
    expect(await ledger()).toEqual(before);
  });
}
