import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NVIDIA_IMPORT_LIMIT, verifyNvidiaSemanticImport } from "../lib/nvidia-semantic-import";
import { nvidiaMapping } from "./fixtures/nvidia-import";

const exec = promisify(execFile);
const source = resolve("tests/fixtures/nvidia-sql-attribute.json");
let dir: string, mapping: string;
const invoke = (...args: string[]) => exec(process.execPath, [join(dir, "scripts/stage-nvidia-import.js"), ...args], { cwd: dir });

describe("offline NVIDIA import command", () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "odap-nvidia-cli-"));
    await exec(process.execPath, [require.resolve("typescript/bin/tsc"), "-p", "scripts/tsconfig.nvidia-import.json", "--outDir", dir]);
    mapping = join(dir, "mapping.json");
    await writeFile(mapping, JSON.stringify(nvidiaMapping()));
  }, 30_000);
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  it("stages a self-contained pinned review bundle outside the checkout without printing its contents", async () => {
    const output = join(dir, "bundle.json");
    const { stdout, stderr } = await invoke(source, mapping, output);
    expect(stderr).toBe("");
    const report = JSON.parse(stdout);
    expect(report).toEqual({ status: "staged-only", evidenceDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) });
    const bundle = await verifyNvidiaSemanticImport(await readFile(output, "utf8"), report.evidenceDigest);
    expect(bundle.evidence.sourceJson).toBe(await readFile(source, "utf8"));
  });

  it("never overwrites an existing output or an input file", async () => {
    const output = join(dir, "existing.json");
    await writeFile(output, "preserve-existing");
    await expect(invoke(source, mapping, output)).rejects.toMatchObject({ code: 1, stdout: "" });
    expect(await readFile(output, "utf8")).toBe("preserve-existing");
    const before = await readFile(mapping, "utf8");
    await expect(invoke(source, mapping, mapping)).rejects.toMatchObject({ code: 1, stdout: "" });
    expect(await readFile(mapping, "utf8")).toBe(before);
  });

  it("rejects invalid encoding, BOM, oversized and private malformed input without leaking it", async () => {
    const file = join(dir, "private-fixture.json"), output = join(dir, "must-not-exist.json");
    for (const bytes of [Buffer.from([0xff]), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), await readFile(source)]),
      Buffer.alloc(NVIDIA_IMPORT_LIMIT + 1), Buffer.from("private-sql-and-identity")]) {
      await writeFile(file, bytes);
      await expect(invoke(file, mapping, output)).rejects.toMatchObject({ code: 1, stdout: "",
        stderr: expect.stringMatching(/^Unable to stage import: invalid input or output unavailable\r?\n$/) });
      await expect(readFile(output)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("rejects a directory input and unknown version without creating output", async () => {
    const output = join(dir, "must-not-exist.json"), unknown = join(dir, "unknown.json");
    await writeFile(unknown, JSON.stringify({ ...nvidiaMapping(), upstreamCommit: "main" }));
    await expect(invoke(dir, mapping, output)).rejects.toMatchObject({ code: 1, stdout: "" });
    await expect(invoke(source, unknown, output)).rejects.toMatchObject({ code: 1, stdout: "" });
    await expect(readFile(output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("requires explicit input, mapping and new output paths", async () => {
    await expect(invoke()).rejects.toMatchObject({ code: 2, stdout: "" });
    expect((await invoke("--help")).stdout).toContain("Usage: stage-nvidia-import");
  });
});
