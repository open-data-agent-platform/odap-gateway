import { describe, expect, it, vi } from "vitest";
import { canonicalControlJson, sha256Text } from "../lib/control-objects";
import { NVIDIA_IMPORT_LIMIT, prepareNvidiaSemanticImport, verifyNvidiaSemanticImport } from "../lib/nvidia-semantic-import";
import source from "./fixtures/nvidia-sql-attribute.json";
import { nvidiaMapping } from "./fixtures/nvidia-import";

const stage = (response: unknown = source, mapping: unknown = nvidiaMapping()) =>
  prepareNvidiaSemanticImport(JSON.stringify(response), JSON.stringify(mapping));

describe("version-pinned NVIDIA context import", () => {
  it.each([true, false, null, undefined])("maps upstream certification %s only to unverified candidate context", async certified => {
    const response = { data: { ...source.data, certified } };
    const bundle = await stage(response);
    expect(bundle.evidence).toMatchObject({ gatewayState: "candidate", authenticity: "operator-supplied-unverified",
      certification: certified === true ? "upstream-certified" : certified === false ? "upstream-uncertified" : "upstream-unknown" });
    expect(bundle.proposal.ownerId).toBe("owner");
    expect(bundle.proposal.ownerId).not.toBe(source.data.owner_id);
    expect(JSON.parse(bundle.evidence.sourceJson)).toEqual(JSON.parse(JSON.stringify(response)));
    expect(bundle.evidence.sourceDigest).toBe(await sha256Text(JSON.stringify(response)));
    expect(bundle.proposal.definitionJson).toBe(canonicalControlJson(nvidiaMapping().definition));
    expect(bundle.proposal.provenanceRef).toBe("urn:odap:nvidia-import:" + bundle.evidenceDigest);
    expect(await verifyNvidiaSemanticImport(JSON.stringify(bundle), bundle.evidenceDigest)).toEqual(bundle);
  });

  it("retains exact source text and never executes SQL or contacts an upstream", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No network"));
    try {
      const text = JSON.stringify({ data: { ...source.data, sql: "DROP TABLE orders; -- untrusted context" } }, null, 2) + "\n";
      const bundle = await prepareNvidiaSemanticImport(text, JSON.stringify(nvidiaMapping()));
      expect(bundle.evidence.sourceJson).toBe(text);
      expect(bundle.proposal.definitionJson).not.toContain("DROP TABLE");
      expect(fetch).not.toHaveBeenCalled();
    } finally { fetch.mockRestore(); }
  });

  it.each([
    { upstreamCommit: "main" }, { upstreamCommit: "0".repeat(40) }, { sourceInstance: "" },
    { attributeId: "other" }, { capturedAt: "yesterday" }, { tenantId: "other" },
    { revisionId: "" }, { ownerId: "" }, { gatewayState: "released" },
  ])("rejects unsupported or mismatched mapping %j", async change => {
    await expect(stage(source, { ...nvidiaMapping(), ...change })).rejects.toThrow();
  });

  it.each(["true", 1, {}, []])("rejects ambiguous certification %j", async certified => {
    await expect(stage({ data: { ...source.data, certified } })).rejects.toThrow("certification");
  });

  it.each([null, [], { data: null }, { data: [source.data] }, { data: source.data, count: 1 },
    { data: { ...source.data, releaseId: "upstream-cannot-release" } }, { data: { ...source.data, sql: null } },
    { data: { ...source.data, owner_id: 12 } }])("rejects unsupported envelopes or attribute fields %j", async response => {
    await expect(stage(response)).rejects.toThrow();
  });

  it("rejects oversized UTF-8 and mapping files before producing a bundle", async () => {
    await expect(prepareNvidiaSemanticImport(" ".repeat(NVIDIA_IMPORT_LIMIT + 1), "{}")).rejects.toThrow();
    await expect(prepareNvidiaSemanticImport('"' + "\u4e2d".repeat(NVIDIA_IMPORT_LIMIT / 2) + '"', "{}")).rejects.toThrow();
    await expect(prepareNvidiaSemanticImport(JSON.stringify(source), " ".repeat(48 * 1024 + 1))).rejects.toThrow();
  });

  it("does not accept raw SQL or a foreign profile as a local metric definition", async () => {
    for (const definition of [{ ...nvidiaMapping().definition, sql: "SELECT 1" },
      { ...nvidiaMapping().definition, profile: "upstream.sql" }, { ...nvidiaMapping().definition, table: null }]) {
      await expect(stage(source, { ...nvidiaMapping(), definition })).rejects.toThrow();
    }
  });

  it("binds changes in SQL, certification, ownership and local definition to a new evidence pin", async () => {
    const original = await stage();
    const variants = [
      await stage({ data: { ...source.data, certified: false } }),
      await stage({ data: { ...source.data, sql: "SELECT 1" } }),
      await stage({ data: { ...source.data, owner_id: "another-upstream-owner" } }),
      await stage(source, { ...nvidiaMapping(), ownerId: "another-local-owner" }),
      await stage(source, { ...nvidiaMapping(), definition: { ...nvidiaMapping().definition, sourceRevision: "s2" } }),
    ];
    for (const bundle of variants) {
      expect(bundle.evidenceDigest).not.toBe(original.evidenceDigest);
      await expect(verifyNvidiaSemanticImport(JSON.stringify(bundle), original.evidenceDigest)).rejects.toThrow("mismatch");
    }
  });

  it("requires an external pin and rejects tampering even when the bundle carries its old digest", async () => {
    const original = await stage();
    for (const pin of ["", "sha256:short", "sha256:" + "0".repeat(64)]) {
      await expect(verifyNvidiaSemanticImport(JSON.stringify(original), pin)).rejects.toThrow();
    }
    for (const change of [
      { ...original, evidence: { ...original.evidence, gatewayState: "released" } },
      { ...original, proposal: { ...original.proposal, ownerId: "other" } },
      { ...original, evidence: { ...original.evidence, certification: "gateway-approved" } },
      { ...original, evidence: { ...original.evidence, sourceDigest: "sha256:" + "0".repeat(64) } },
      { ...original, approvalId: "injected" },
    ]) await expect(verifyNvidiaSemanticImport(JSON.stringify(change), original.evidenceDigest)).rejects.toThrow();
  });
});
