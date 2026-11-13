import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildDetachedVerifier } from "./fixtures/detached-verifier";
import { syntheticCancellationEvidence } from "./fixtures/cancellation-evidence";
import { canonicalControlJson, sha256Text } from "../lib/control-objects";
import { cancellationEvidenceMaxBytes } from "../lib/cancellation-evidence";

let dir:string,bundle:string,pin:string,json:string,invoke:Awaited<ReturnType<typeof buildDetachedVerifier>>;
describe("standalone cancellation request verifier",() => {
  beforeAll(async () => {
    dir=await mkdtemp(join(tmpdir(),"odap-cancel-evidence-")); bundle=join(dir,"request.json"); pin=join(dir,"pin.sha256");
    json=canonicalControlJson(await syntheticCancellationEvidence());
    await writeFile(bundle,json); await writeFile(pin,await sha256Text(json));
    invoke=await buildDetachedVerifier(dir,"verify-cancellation-evidence");
  },30000);
  afterAll(async () => { if(dir) await rm(dir,{recursive:true,force:true}); });
  it("runs outside the checkout with a separate required pin",async () => {
    const result=await invoke(bundle,"t","i","fixture",pin);
    expect(result.stderr).toBe(""); expect(JSON.parse(result.stdout)).toMatchObject({ consistent:true,
      issuerAuthenticated:false,cancellationConfirmed:false,scope:"recorded-request-only" });
  });
  it.each([["peer","i","fixture"],["t","other","fixture"],["t","i","other"]])("rejects wrong scope %s/%s/%s",async (...scope) => {
    await expect(invoke(bundle,...scope,pin)).rejects.toMatchObject({ code:1,stdout:"",stderr:expect.stringContaining("scope mismatch") });
  });
  it("does not invent a checksum or audience when one is missing",async () => {
    await expect(invoke(bundle,"t","i","fixture")).rejects.toMatchObject({code:2,stdout:""});
    await expect(invoke(bundle,"t","i","",pin)).rejects.toMatchObject({code:2,stdout:""});
  });
  it("rejects a consistent actor replacement against the retained checksum",async () => {
    const data=JSON.parse(json); data.request.requestedBy="other";
    const file=join(dir,"altered.json"); await writeFile(file,canonicalControlJson(data));
    await expect(invoke(file,"t","i","fixture",pin)).rejects.toMatchObject({code:1,stdout:"",stderr:expect.stringContaining("checksum mismatch")});
  });
  it("rejects contradictory request attribution even with a matching checksum",async () => {
    const data=JSON.parse(json); data.request.audience="other";
    const file=join(dir,"contradiction.json"),value=canonicalControlJson(data); await writeFile(file,value);
    await writeFile(file+".sha256",await sha256Text(value));
    await expect(invoke(file,"t","i","fixture",file+".sha256")).rejects.toMatchObject({code:1,stdout:"",stderr:expect.stringMatching(/^Unreadable or invalid evidence input\r?\n$/)});
  });
  it("refuses private malformed, invalid UTF-8, BOM and oversized files without echoing them",async () => {
    const file=join(dir,"private-path.json");
    for(const bytes of [Buffer.from("private-content"),Buffer.from([0xff]),Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),Buffer.from(json)]),Buffer.alloc(cancellationEvidenceMaxBytes+1)]) {
      await writeFile(file,bytes);
      await expect(invoke(file,"t","i","fixture",pin)).rejects.toMatchObject({code:1,stdout:"",stderr:expect.stringMatching(/^Unreadable or invalid evidence input\r?\n$/)});
    }
  });
});
