import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const exec = promisify(execFile);
let dir: string;
let cli: string;
const request = { schemaVersion: "adapter-read-requirements.v1", engine: "bigquery",
  action: "odap.metric-read.v1", requireProviderVerification: false, limits: [{ unit: "billed-bytes", maximum: 1 }] };
const invoke = (...args: string[]) => exec(process.execPath, [cli, ...args], { cwd: dir, windowsHide: true });

describe("detached database adapter inspector", () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "odap-adapter-"));
    await exec(process.execPath, [resolve("node_modules/typescript/bin/tsc"), "-p", "scripts/tsconfig.adapters.json", "--outDir", dir],
      { windowsHide: true });
    cli = join(dir, "scripts/inspect-database-adapter.js");
  }, 30_000);
  afterAll(async () => {
    if (dir && resolve(dir).startsWith(resolve(tmpdir()) + sep)) await rm(dir, { recursive: true, force: true });
  });
  it("lists implemented and unimplemented engines without loading runtime dependencies", async () => {
    const { stdout, stderr } = await invoke("--list");
    expect(stderr).toBe("");
    const result = JSON.parse(stdout);
    expect(result.authorizationGranted).toBe(false);
    expect(result.adapters.filter((a: { implementation: string }) => a.implementation === "implemented")).toHaveLength(1);
  });
  it("distinguishes compatible offline checks from unsupported requests", async () => {
    const path = join(dir, "request.json");
    await writeFile(path, JSON.stringify(request));
    expect(JSON.parse((await invoke("--request", path)).stdout)).toMatchObject({ compatible: true, authorizationGranted: false });
    for (const change of [{ engine: "postgresql" }, { requireProviderVerification: true }, { token: "SYNTHETIC-SECRET" }]) {
      await writeFile(path, JSON.stringify({ ...request, ...change }));
      await expect(invoke("--request", path)).rejects.toMatchObject({ code: 2, stderr: "", stdout: expect.not.stringContaining("SYNTHETIC-SECRET") });
    }
  });
  it.each([[], ["--list", "extra"], ["--request"], ["--request", "MISSING-SECRET-FILENAME"]])("fails safely on arguments %j", async (...args) => {
    await expect(invoke(...args)).rejects.toMatchObject({ code: 1, stdout: "", stderr: expect.not.stringContaining("MISSING-SECRET") });
  });
  it("rejects malformed, oversized and invalid UTF-8 input without echoing content", async () => {
    for (const bytes of [Buffer.from('{"secret":"SYNTHETIC-SECRET"'), Buffer.alloc(65537, 32), Buffer.from([0xc3, 0x28])]) {
      const path = join(dir, "invalid.json");
      await writeFile(path, bytes);
      await expect(invoke("--request", path)).rejects.toMatchObject({ code: 1, stdout: "", stderr: expect.not.stringContaining("SYNTHETIC-SECRET") });
    }
  });
});
