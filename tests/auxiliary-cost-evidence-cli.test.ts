import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildDetachedVerifier } from "./fixtures/detached-verifier";
import { canonicalControlJson, sha256Text } from "../lib/control-objects";
import { auxiliaryEvidence } from "./fixtures/auxiliary-evidence";

let dir: string, bundle: string, pin: string, json: string;
let invoke: Awaited<ReturnType<typeof buildDetachedVerifier>>;
describe("detached auxiliary evidence CLI",() => {
  beforeAll(async () => {
    dir=await mkdtemp(join(tmpdir(),"odap-aux-cli-"));bundle=join(dir,"bundle.json");pin=join(dir,"pin.sha256");
    json=canonicalControlJson(auxiliaryEvidence()); await writeFile(bundle,json);await writeFile(pin,await sha256Text(json));
    invoke=await buildDetachedVerifier(dir,"verify-auxiliary-cost-evidence");
  },30000);
  afterAll(async () => {await rm(dir,{recursive:true,force:true});});
  it("runs outside the checkout with an explicit pin and limited claims",async () => {
    const result=await invoke(bundle,"t","i",pin);expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({consistent:true,issuerAuthenticated:false,completeWorkflowCost:false,settledActualMicroUsd:"12"});
  });
  it.each([["other","i"],["t","other"]])("rejects scope %s/%s",async (tenant,intent) => {
    await expect(invoke(bundle,tenant,intent,pin)).rejects.toMatchObject({code:1,stdout:"",stderr:expect.stringContaining("scope mismatch")});
  });
  it("does not invent the expected pin or permit extra arguments",async () => {
    for(const args of [[bundle,"t","i"],[bundle,"t","i",pin,"--force"]])
      await expect(invoke(...args)).rejects.toMatchObject({code:2,stdout:""});
  });
  it("rejects consistent tampering against the retained pin",async () => {
    const changed=auxiliaryEvidence();changed.components[0].settlement.actualMicroUsd=13;
    const file=join(dir,"changed.json");await writeFile(file,canonicalControlJson(changed));
    await expect(invoke(file,"t","i",pin)).rejects.toMatchObject({code:1,stdout:"",stderr:expect.stringContaining("checksum mismatch")});
  });
  it.each([Buffer.from([0xff]),Buffer.from("private-fixture-text"),Buffer.from("\ufeff{}"),Buffer.alloc(4*1024*1024+1)])
    ("rejects malformed or oversized input without disclosing its content",async bytes => {
      const file=join(dir,"private-input.json");await writeFile(file,bytes);
      await expect(invoke(file,"t","i",pin)).rejects.toMatchObject({code:1,stdout:"",stderr:expect.stringMatching(/^Unreadable or invalid evidence input\r?\n$/)});
    });
  it("rejects malformed pins and unreadable paths without echoing private paths",async () => {
    const bad=join(dir,"bad.sha256");await writeFile(bad,"sha256:bad");
    await expect(invoke(bundle,"t","i",bad)).rejects.toMatchObject({code:1,stdout:"",stderr:expect.stringContaining("Invalid pin")});
    await expect(invoke(join(dir,"absent-private.json"),"t","i",pin)).rejects.toMatchObject({code:1,stdout:"",stderr:expect.stringMatching(/^Unreadable or invalid evidence input\r?\n$/)});
  });
  it.each(["", "\n", "\r\n"])("accepts only an optional single final newline: %j",async suffix => {
    const file=join(dir,"newline.sha256");await writeFile(file,(await sha256Text(json))+suffix);
    expect(JSON.parse((await invoke(bundle,"t","i",file)).stdout)).toMatchObject({consistent:true});
  });
  it.each(["\n\n", "\r\n\r\n", "\t", " ", "\r"])("rejects trailing pin content: %j",async suffix => {
    const file=join(dir,"bad-newline.sha256");await writeFile(file,(await sha256Text(json))+suffix);
    await expect(invoke(bundle,"t","i",file)).rejects.toMatchObject({code:1,stdout:"",stderr:expect.stringContaining("Invalid pin")});
  });
});
