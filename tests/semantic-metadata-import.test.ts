import { describe, expect, it } from "vitest";
import { canonicalControlJson, sha256Text } from "../lib/control-objects";
import { prepareSemanticMetadataImport, SEMANTIC_METADATA_LIMIT, verifySemanticMetadataImport } from "../lib/semantic-metadata-import";
import { cubeMetadata, dbtManifest, metadataMapping, metadataSource } from "./fixtures/semantic-metadata";

describe.each(["cube", "dbt"] as const)("%s offline candidate context", kind => {
  const prepare = (source: unknown = metadataSource(kind), mapping: unknown = metadataMapping(kind)) =>
    prepareSemanticMetadataImport(JSON.stringify(source), JSON.stringify(mapping));

  it("pins exact source and explicit mapping without upgrading upstream authority", async () => {
    const sourceJson = JSON.stringify(metadataSource(kind), null, 2) + "\n";
    const result = await prepareSemanticMetadataImport(sourceJson, JSON.stringify(metadataMapping(kind)));
    expect(result.evidence).toMatchObject({ sourceJson, sourceDigest: await sha256Text(sourceJson),
      authenticity: "operator-supplied-unverified", gatewayState: "candidate", issuerAuthenticated: false, executionAuthorized: false });
    expect(result.evidence.selected.resourceId).toBe(metadataMapping(kind).resourceId);
    expect(result.proposal).toEqual({ revisionId: `${kind}-revision`, ownerId: "owner",
      provenanceRef: "urn:odap:semantic-metadata-import:" + result.evidenceDigest,
      definitionJson: canonicalControlJson(metadataMapping(kind).definition) });
    expect(await verifySemanticMetadataImport(JSON.stringify(result), result.evidenceDigest)).toEqual(result);
  });

  it.each([
    { sourceFormat: "unknown" }, { sourceVersion: "main" }, { sourceVersion: 42 }, { sourceInstance: "" },
    { containerId: "missing" }, { resourceId: "missing" }, { capturedAt: "2026-02-30T00:00:00.000Z" },
    { tenantId: "other" }, { ownerId: "x\n" }, { revisionId: "" }, { approved: true },
  ])("rejects unsafe mapping %j", async change => {
    await expect(prepare(undefined, { ...metadataMapping(kind), ...change })).rejects.toThrow();
  });

  it("requires explicit definition and source metadata rather than translating upstream SQL", async () => {
    const mapping = metadataMapping(kind);
    await expect(prepare(undefined, { ...mapping, definition: { ...mapping.definition, profile: "auto-sql" } })).rejects.toThrow();
    await expect(prepare(undefined, { ...mapping, definition: { ...mapping.definition, table: null } })).rejects.toThrow();
    await expect(prepare(undefined, { ...mapping, definition: { ...mapping.definition, extra: "unreviewed" } })).rejects.toThrow();
    const source = { ...metadataSource(kind), sql: "DELETE FROM sensitive_table", certified: true };
    const result = await prepare(source);
    expect(result.proposal.definitionJson).toBe(canonicalControlJson(mapping.definition));
    expect(result.evidence.executionAuthorized).toBe(false);
  });

  it("binds whitespace, local owner and capture assertions in the independent pin", async () => {
    const result = await prepare();
    const changed = await prepare(undefined, { ...metadataMapping(kind), ownerId: "other-owner" });
    const spaced = await prepareSemanticMetadataImport(JSON.stringify(metadataSource(kind)) + "\n", JSON.stringify(metadataMapping(kind)));
    const captured = await prepare(undefined, { ...metadataMapping(kind), capturedAt: "2026-11-15T00:00:00.000Z" });
    for (const alternate of [changed, spaced, captured]) {
      expect(alternate.evidenceDigest).not.toBe(result.evidenceDigest);
      await expect(verifySemanticMetadataImport(JSON.stringify(alternate), result.evidenceDigest)).rejects.toThrow("bundle mismatch");
    }
  });

  it("rejects bundle tampering and missing or mismatched trusted pins", async () => {
    const result = await prepare();
    for (const alternate of [
      { ...result, proposal: { ...result.proposal, ownerId: "upstream-owner" } },
      { ...result, evidence: { ...result.evidence, issuerAuthenticated: true } },
      { ...result, evidence: { ...result.evidence, selected: { ...result.evidence.selected, resourceId: "other" } } },
      { ...result, evidenceDigest: "sha256:" + "0".repeat(64) },
      { ...result, extra: true },
    ]) await expect(verifySemanticMetadataImport(JSON.stringify(alternate), result.evidenceDigest)).rejects.toThrow();
    await expect(verifySemanticMetadataImport(JSON.stringify(result), "")).rejects.toThrow("Invalid import pin");
    await expect(verifySemanticMetadataImport(JSON.stringify(result), "sha256:" + "0".repeat(64))).rejects.toThrow("bundle mismatch");
  });
});

describe("source identity boundaries", () => {
  it("rejects Cube duplicate containers or members, including cross-container collisions", async () => {
    const cube = cubeMetadata().cubes[0];
    for (const source of [
      { cubes: [cube, cube] },
      { cubes: [{ ...cube, measures: [cube.measures[0], cube.measures[0]] }] },
      { cubes: [cube, { ...cube, name: "other" }] },
      { cubes: [{ ...cube, measures: [] }] },
      { cubes: [{ ...cube, type: "unknown" }] },
      { cubes: [{ ...cube, measures: [{ ...cube.measures[0], type: 42 }] }] },
      { cubes: null },
    ]) await expect(prepareSemanticMetadataImport(JSON.stringify(source), JSON.stringify(metadataMapping("cube")))).rejects.toThrow();
  });

  it("accepts a Cube view without turning upstream aggregation into executable semantics", async () => {
    const cube = cubeMetadata().cubes[0];
    const result = await prepareSemanticMetadataImport(JSON.stringify({ cubes: [{ ...cube, type: "view",
      measures: [{ ...cube.measures[0], aggType: "custom-upstream" }] }] }), JSON.stringify(metadataMapping("cube")));
    expect(result.evidence.selected.kind).toBe("cube-measure");
    expect(result.proposal.definitionJson).toBe(canonicalControlJson(metadataMapping("cube").definition));
  });

  it("rejects dbt schema/version drift and resource-kind, package, duplicate or disabled conflicts", async () => {
    const source = dbtManifest(), id = "metric.demo.net_revenue", metric = source.metrics[id];
    for (const altered of [
      { ...source, metadata: { ...source.metadata, dbt_schema_version: "https://schemas.getdbt.com/dbt/manifest/v11.json" } },
      { ...source, metadata: { ...source.metadata, dbt_version: "1.11.6" } },
      { ...source, metrics: { [id]: { ...metric, resource_type: "model" } } },
      { ...source, metrics: { [id]: { ...metric, package_name: "other" } } },
      { ...source, metrics: { [id]: { ...metric, unique_id: "metric.other.net_revenue" } } },
      { ...source, metrics: { [id]: metric, alias: metric } },
      { ...source, metrics: { [id]: { ...metric, config: { enabled: false } } } },
      { ...source, metrics: { [id]: { ...metric, config: { enabled: "true" } } } },
      { ...source, metrics: { [id]: { ...metric, type_params: null } } },
      { ...source, metrics: { [id]: { ...metric, type: "unsupported" } } },
      { ...source, disabled: { [id]: [metric] } },
      { ...source, disabled: [] },
      { ...source, metrics: {} },
    ]) await expect(prepareSemanticMetadataImport(JSON.stringify(altered), JSON.stringify(metadataMapping("dbt")))).rejects.toThrow();
  });

  it("accepts the v12 nullable disabled inventory without inventing disabled resources", async () => {
    const result = await prepareSemanticMetadataImport(JSON.stringify({ ...dbtManifest(), disabled: null }), JSON.stringify(metadataMapping("dbt")));
    expect(result.evidence.selected.resourceId).toBe("metric.demo.net_revenue");
    expect(result.evidence.executionAuthorized).toBe(false);
  });

  it("refuses malformed JSON, oversized inputs and the other source format", async () => {
    const mapping = JSON.stringify(metadataMapping("cube"));
    for (const source of ["not-json", "\ufeff{}", " ".repeat(SEMANTIC_METADATA_LIMIT + 1), JSON.stringify(dbtManifest())]) {
      await expect(prepareSemanticMetadataImport(source, mapping)).rejects.toThrow();
    }
    await expect(prepareSemanticMetadataImport(JSON.stringify(cubeMetadata()), " ".repeat(48 * 1024 + 1))).rejects.toThrow();
    await expect(prepareSemanticMetadataImport(JSON.stringify(cubeMetadata()), JSON.stringify(metadataMapping("dbt")))).rejects.toThrow();
  });

  it("rejects literal and escaped duplicate source, mapping and bundle properties", async () => {
    const source = JSON.stringify(cubeMetadata()), mapping = JSON.stringify(metadataMapping("cube"));
    for (const duplicate of [source.replace('{"cubes":', '{"cubes":[],"cubes":'),
      source.replace('{"cubes":', '{"cu\\u0062es":[],"cubes":')]) {
      await expect(prepareSemanticMetadataImport(duplicate, mapping)).rejects.toThrow("Duplicate import property");
    }
    await expect(prepareSemanticMetadataImport(source, mapping.replace('"tenantId":"t"', '"tenantId":"other","tenantId":"t"')))
      .rejects.toThrow("Duplicate import property");
    const result = await prepareSemanticMetadataImport(source, mapping);
    await expect(verifySemanticMetadataImport(JSON.stringify(result).replace('"executionAuthorized":false',
      '"executionAuthorized":true,"executionAuthorized":false'), result.evidenceDigest)).rejects.toThrow("Duplicate import property");
  });

  it("rejects JSONC, trailing commas, non-finite numbers and excessive nesting", async () => {
    const mapping = JSON.stringify(metadataMapping("cube"));
    for (const source of [
      JSON.stringify(cubeMetadata()).replace('{"cubes":', '{/*comment*/"cubes":'),
      JSON.stringify(cubeMetadata()).replace('"segments":[]', '"segments":[], '),
      JSON.stringify(cubeMetadata()).replace('"segments":[]', '"segments":[],"extra":1e999'),
      JSON.stringify({ ...cubeMetadata(), deep: "replace-deep" }).replace('"replace-deep"', '['.repeat(65) + '0' + ']'.repeat(65)),
    ]) await expect(prepareSemanticMetadataImport(source, mapping)).rejects.toThrow();
    const repeatedNamesInSeparateObjects = { ...cubeMetadata(), extra: [{ a: 1 }, { a: 2 }] };
    expect((await prepareSemanticMetadataImport(JSON.stringify(repeatedNamesInSeparateObjects), mapping)).evidence.gatewayState).toBe("candidate");
    let deep: unknown = 0;
    for (let i = 0; i < 61; i++) deep = [deep];
    const mapped = metadataMapping("cube");
    const boundary = await prepareSemanticMetadataImport(JSON.stringify(cubeMetadata()), JSON.stringify({ ...mapped,
      definition: { ...mapped.definition, filters: { nested: deep } } }));
    expect(await verifySemanticMetadataImport(JSON.stringify(boundary), boundary.evidenceDigest)).toEqual(boundary);
  });
});
