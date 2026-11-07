import { describe, expect, it } from "vitest";
import { auxiliaryCostMaxBytes, auxiliaryCostMaxComponents, verifyAuxiliaryCostEvidence } from "../lib/auxiliary-cost-evidence";
import { canonicalControlJson, sha256Text } from "../lib/control-objects";
import { auxiliaryEvidence } from "./fixtures/auxiliary-evidence";

type Bundle = ReturnType<typeof auxiliaryEvidence>;
const verify = (data: unknown) => verifyAuxiliaryCostEvidence(canonicalControlJson(data),{tenantId:"t",intentId:"i"});
describe("detached auxiliary component evidence",() => {
  it("reports attributed recorded costs without claiming provider identity or workflow completeness",async () => {
    expect(await verify(auxiliaryEvidence())).toMatchObject({consistent:true,issuerAuthenticated:false,completeWorkflowCost:false,
      recordedComponents:1,settledComponents:1,pendingComponents:0,settledActualMicroUsd:"12",pendingReservedMicroUsd:"0"});
  });
  it("does not invent operations or overall zero cost for an empty inventory",async () => {
    const data=auxiliaryEvidence(); data.components=[];
    expect(await verify(data)).toMatchObject({recordedComponents:0,settledActualMicroUsd:"0",completeWorkflowCost:false});
  });
  it("preserves unknown billing separately from an explicit final zero",async () => {
    const data=auxiliaryEvidence(); const pending={...data.components[0],settlement:null,settlementEvents:[]};
    expect(await verify({...data,components:[pending]})).toMatchObject({pendingComponents:1,pendingReservedMicroUsd:"30",settledActualMicroUsd:"0",allRecordedComponentsSettled:false});
    data.components[0].settlement.actualMicroUsd=0;
    expect(await verify(data)).toMatchObject({pendingComponents:0,settledComponents:1,settledActualMicroUsd:"0"});
  });
  it("sums large actual charges exactly using decimal strings",async () => {
    const data=auxiliaryEvidence(), first=data.components[0]; first.settlement.actualMicroUsd=Number.MAX_SAFE_INTEGER;
    const second=structuredClone(first); second.id="tool-1"; second.kind="tool"; second.operationRef=second.settlement.operationRef="fixture:tool";
    second.settlement.billingRef="fixture:bill-2";
    second.reservationEvents[0].objectId=second.settlementEvents[0].objectId=second.id;
    second.reservationEvents[0].sequence=3; second.settlementEvents[0].sequence=4;
    data.components.push(second);
    expect(await verify(data)).toMatchObject({settledActualMicroUsd:"18014398509481982",settledComponents:2});
  });
  it("requires canonical bytes and a matching independently supplied digest",async () => {
    const data=auxiliaryEvidence(), json=canonicalControlJson(data), digest=await sha256Text(json);
    expect((await verifyAuxiliaryCostEvidence(json,{tenantId:"t",intentId:"i"},digest)).digest).toBe(digest);
    await expect(verifyAuxiliaryCostEvidence(json+"\n",{tenantId:"t",intentId:"i"},digest)).rejects.toThrow("Noncanonical");
    data.components[0].settlement.actualMicroUsd=13;
    await expect(verifyAuxiliaryCostEvidence(canonicalControlJson(data),{tenantId:"t",intentId:"i"},digest)).rejects.toThrow("checksum mismatch");
    await expect(verifyAuxiliaryCostEvidence(json,{tenantId:"t",intentId:"other"})).rejects.toThrow("scope mismatch");
  });
  it("cannot verify completeness or origin against a digest chosen by the same author",async () => {
    const data=auxiliaryEvidence(); data.components=[]; const json=canonicalControlJson(data);
    expect(await verifyAuxiliaryCostEvidence(json,{tenantId:"t",intentId:"i"},await sha256Text(json)))
      .toMatchObject({issuerAuthenticated:false,completeWorkflowCost:false,recordedComponents:0});
  });
  const mutations: [string,(d: Bundle) => unknown][] = [
    ["unknown profile",d=>d.profile="other"],["unqualified total scope",d=>d.scope="workflow-total"],
    ["foreign tenant",d=>d.intent.tenantId="other"],["bad intent digest",d=>d.intent.actionDigest="bad"],
    ["reused component",d=>d.components.push(structuredClone(d.components[0]))],
    ["unsupported kind",d=>d.components[0].kind="sql"],["coerced kind",d=>Object.assign(d.components[0],{kind:["model"]})],
    ["empty ID",d=>d.components[0].id=""],["NUL reference",d=>d.components[0].operationRef+="\u0000"],
    ["trailing newline reference",d=>d.components[0].operationRef+="\n"],
    ["bad operation digest",d=>d.components[0].operationDigest="sha256:bad"],
    ["zero hold",d=>d.components[0].upperBoundMicroUsd=0],["negative actual",d=>d.components[0].settlement.actualMicroUsd=-1],
    ["wrong bill operation",d=>d.components[0].settlement.operationRef="other"],
    ["missing reservation audit",d=>d.components[0].reservationEvents=[]],
    ["missing settlement audit",d=>d.components[0].settlementEvents=[]],
    ["duplicate audit",d=>d.components[0].reservationEvents.push(structuredClone(d.components[0].reservationEvents[0]))],
    ["audit actor",d=>d.components[0].reservationEvents[0].actor="other"],
    ["audit tenant",d=>d.components[0].settlementEvents[0].tenantId="other"],
    ["audit object",d=>d.components[0].settlementEvents[0].objectId="other"],
    ["audit kind",d=>d.components[0].settlementEvents[0].kind="release"],
    ["audit time",d=>d.components[0].settlementEvents[0].recordedAt="2026-11-08T00:00:00.000Z"],
    ["reused sequence",d=>d.components[0].settlementEvents[0].sequence=1],
    ["backward sequence",d=>d.components[0].reservationEvents[0].sequence=3],
    ["bad timestamp",d=>d.components[0].reservedAt="2026-02-30T00:00:00.000Z"],
    ["earlier bill",d=>d.components[0].settlement.recordedAt="2026-11-06T00:00:00.000Z"],
    ["orphan settlement event",d=>Object.assign(d.components[0],{settlement:null})],
    ["unknown field",d=>Object.assign(d,{totalCost:12})],
    ["missing final amount",d=>Object.assign(d.components[0].settlement,{actualMicroUsd:null})]
  ];
  it.each(mutations)("rejects %s",async (_name,mutate) => {const data=auxiliaryEvidence();mutate(data);await expect(verify(data)).rejects.toThrow();});
  it.each(["operation","bill","order"])("rejects conflicting multi-component %s",async collision => {
    const data=auxiliaryEvidence(), second=structuredClone(data.components[0]); second.id="tool-1";
    second.reservationEvents[0].objectId=second.settlementEvents[0].objectId=second.id;
    second.reservationEvents[0].sequence=3; second.settlementEvents[0].sequence=4;
    if(collision!=="operation") second.operationRef=second.settlement.operationRef="fixture:tool";
    if(collision!=="bill") second.settlement.billingRef="fixture:bill-2";
    data.components.push(second); if(collision==="order") data.components.reverse();
    await expect(verify(data)).rejects.toThrow();
  });
  it("bounds component count and raw input size",async () => {
    const data=auxiliaryEvidence(); data.components=Array(auxiliaryCostMaxComponents+1).fill(data.components[0]);
    await expect(verify(data)).rejects.toThrow("profile");
    await expect(verifyAuxiliaryCostEvidence(" ".repeat(auxiliaryCostMaxBytes+1),{tenantId:"t",intentId:"i"})).rejects.toThrow("size");
  });
  it.each([1.5,Number.MAX_SAFE_INTEGER+1,"12",null])("rejects non-safe numeric evidence: %s",async value => {
    const data=auxiliaryEvidence();Object.assign(data.components[0].settlement,{actualMicroUsd:value});
    await expect(verifyAuxiliaryCostEvidence(JSON.stringify(data),{tenantId:"t",intentId:"i"})).rejects.toThrow();
  });
});
