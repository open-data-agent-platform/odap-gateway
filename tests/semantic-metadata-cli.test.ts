import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SEMANTIC_METADATA_LIMIT, verifySemanticMetadataImport } from "../lib/semantic-metadata-import";
import { metadataMapping, metadataSource } from "./fixtures/semantic-metadata";

const exec = promisify(execFile);
let dir: string, build: string;
const invoke = (...args: string[]) => exec(process.execPath, [join(build, "scripts/stage-semantic-metadata-import.js"), ...args], { cwd: dir });

describe("offline semantic metadata command", () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "odap-metadata-cli-"));
    await mkdir(resolve(".tmp"), { recursive: true });
    build = await mkdtemp(join(resolve(".tmp"), "metadata-cli-"));
    await exec(process.execPath, [require.resolve("typescript/bin/tsc"), "-p", "scripts/tsconfig.semantic-metadata-import.json", "--outDir", build]);
  }, 30_000);
  afterAll(async () => {
    expect(build.startsWith(join(resolve(".tmp"), "metadata-cli-"))).toBe(true);
    expect(dir.startsWith(join(tmpdir(), "odap-metadata-cli-"))).toBe(true);
    await rm(dir, { recursive: true, force: true });
    await rm(build, { recursive: true, force: true });
  });

  it.each(["cube", "dbt"] as const)("stages and verifies %s files outside the checkout with only a digest on stdout", async kind => {
    const source = join(dir, `${kind}.json`), mapping = join(dir, `${kind}-mapping.json`), output = join(dir, `${kind}-bundle.json`);
    const sourceJson = JSON.stringify(metadataSource(kind), null, 2);
    await writeFile(source, sourceJson);
    await writeFile(mapping, JSON.stringify(metadataMapping(kind)));
    const { stdout, stderr } = await invoke(source, mapping, output);
    expect(stderr).toBe("");
    const report = JSON.parse(stdout);
    expect(report).toEqual({ status: "staged-only", evidenceDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) });
    expect((await verifySemanticMetadataImport(await readFile(output, "utf8"), report.evidenceDigest)).evidence.sourceJson).toBe(sourceJson);
  });

  it("does not overwrite existing outputs or inputs", async () => {
    const source = join(dir, "existing-source.json"), mapping = join(dir, "existing-mapping.json"), output = join(dir, "existing-output.json");
    await writeFile(source, JSON.stringify(metadataSource("cube")));
    await writeFile(mapping, JSON.stringify(metadataMapping("cube")));
    await writeFile(output, "retain-original");
    await expect(invoke(source, mapping, output)).rejects.toMatchObject({ code: 1, stdout: "" });
    expect(await readFile(output, "utf8")).toBe("retain-original");
    const before = await readFile(source, "utf8");
    await expect(invoke(source, mapping, source)).rejects.toMatchObject({ code: 1, stdout: "" });
    expect(await readFile(source, "utf8")).toBe(before);
  });

  it("rejects bad encoding, BOM, oversized, private malformed and directory inputs without creating output", async () => {
    const source = join(dir, "private-source.json"), mapping = join(dir, "private-mapping.json"), output = join(dir, "absent.json");
    await writeFile(mapping, JSON.stringify(metadataMapping("dbt")));
    for (const bytes of [Buffer.from([0xff]), Buffer.from("\ufeff" + JSON.stringify(metadataSource("dbt"))),
      Buffer.alloc(SEMANTIC_METADATA_LIMIT + 1), Buffer.from("private-source-contents")]) {
      await writeFile(source, bytes);
      await expect(invoke(source, mapping, output)).rejects.toMatchObject({ code: 1, stdout: "",
        stderr: expect.stringMatching(/^Unable to stage metadata: invalid input or output unavailable\r?\n$/) });
      await expect(readFile(output)).rejects.toMatchObject({ code: "ENOENT" });
    }
    await expect(invoke(dir, mapping, output)).rejects.toMatchObject({ code: 1, stdout: "" });
  });

  it("requires explicit paths and refuses an unsupported format", async () => {
    await expect(invoke()).rejects.toMatchObject({ code: 2, stdout: "" });
    expect((await invoke("--help")).stdout).toContain("Usage: stage-semantic-metadata-import");
    const source = join(dir, "unsupported-source.json"), mapping = join(dir, "unsupported-mapping.json"), output = join(dir, "unsupported-output.json");
    await writeFile(source, JSON.stringify(metadataSource("cube")));
    await writeFile(mapping, JSON.stringify({ ...metadataMapping("cube"), sourceFormat: "cube.unknown.v9" }));
    await expect(invoke(source, mapping, output)).rejects.toMatchObject({ code: 1, stdout: "" });
    await expect(readFile(output)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
