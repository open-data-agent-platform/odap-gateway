import { describe, expect, it } from "vitest";
import { cancellationEvidenceMaxBytes, verifyCancellationEvidence } from "../lib/cancellation-evidence";
import { canonicalControlJson, sha256Text } from "../lib/control-objects";
import { syntheticCancellationEvidence } from "./fixtures/cancellation-evidence";

const scope={ tenantId:"t",intentId:"i",audience:"fixture" };
describe("detached cancellation request consistency",() => {
  it("accepts different historical owners without asserting an outcome or issuer",async () => {
    const json=canonicalControlJson(await syntheticCancellationEvidence());
    expect(await verifyCancellationEvidence(json,scope,await sha256Text(json))).toEqual({ consistent:true,
      issuerAuthenticated:false,cancellationConfirmed:false,scope:"recorded-request-only",digest:await sha256Text(json) });
  });
  it.each([
    ["job","jobId","wrong"],["job","actionTag","wrong"],["job","pendingReceiptId","wrong"],
    ["job","location",""],["job","projectId","https://wrong.test"],
    ["claim","audience","wrong"],["claim","bodyDigest","wrong"],["claim","maximumBytesBilled",0],
    ["claim","maximumBytesBilled",1.5],["claim","maximumBytesBilled",Number.MAX_SAFE_INTEGER+1],
    ["claim","claimedBy",""],["claim","claimedAt","bad"],
    ["request","jobId","wrong"],["request","audience","wrong"],["request","claimBodyDigest","sha256:"+"c".repeat(64)],
    ["request","requestedBy",""],["request","requestedAt","bad"],
    ["request","requestedAt","2025-12-31T23:59:59.999Z"]
  ])("rejects a substituted %s.%s",async (part,key,value) => {
    const data=JSON.parse(canonicalControlJson(await syntheticCancellationEvidence()));
    Object.assign(data[part as string],{ [key]:value });
    await expect(verifyCancellationEvidence(JSON.stringify(data),scope)).rejects.toThrow();
  });
  it.each(["tenantId","intentId","audience"])("requires independently expected %s",async key => {
    const json=canonicalControlJson(await syntheticCancellationEvidence());
    await expect(verifyCancellationEvidence(json,{ ...scope,[key]:"other" })).rejects.toThrow("scope mismatch");
    await expect(verifyCancellationEvidence(json,{ ...scope,[key]:"" })).rejects.toThrow("scope mismatch");
  });
  it("refuses missing/extra fields, new versions and appended outcome assertions",async () => {
    const data=await syntheticCancellationEvidence();
    for(const key of Object.keys(data)) { const partial:Record<string,unknown>={ ...data }; delete partial[key];
      await expect(verifyCancellationEvidence(canonicalControlJson(partial),scope)).rejects.toThrow(); }
    for(const extra of [{ outcome:"cancelled" },{ profile:"v2" },{ scope:"confirmed-cancelled" },
      { request:{ ...data.request,token:"private" } },{ actionDigest:"bad" }])
      await expect(verifyCancellationEvidence(canonicalControlJson({ ...data,...extra }),scope)).rejects.toThrow();
  });
  it("accepts equal recorded times but not a noncanonical representation",async () => {
    const data=await syntheticCancellationEvidence(); data.request.requestedAt=data.claim.claimedAt;
    const json=canonicalControlJson(data); expect(await verifyCancellationEvidence(json,scope)).toMatchObject({ consistent:true });
    await expect(verifyCancellationEvidence(json+"\n",scope)).rejects.toThrow("Noncanonical");
  });
  it("detects consistent historical actor replacement only against an independently retained pin",async () => {
    const data=await syntheticCancellationEvidence(),pin=await sha256Text(canonicalControlJson(data));
    data.request.requestedBy="replacement"; const json=canonicalControlJson(data);
    expect(await verifyCancellationEvidence(json,scope)).toMatchObject({ issuerAuthenticated:false });
    await expect(verifyCancellationEvidence(json,scope,pin)).rejects.toThrow("checksum mismatch");
  });
  it("bounds input by encoded bytes before parsing",async () => {
    for(const json of ["x".repeat(cancellationEvidenceMaxBytes+1),"\u4e2d".repeat(cancellationEvidenceMaxBytes/2)])
      await expect(verifyCancellationEvidence(json,scope)).rejects.toThrow("size");
  });
});
