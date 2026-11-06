import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildDetachedVerifier } from "./fixtures/detached-verifier";

const bundle = resolve("tests/fixtures/settled-job.json");
const pin = resolve("tests/pins/settled-job.sha256");
let dir: string;

let invoke: Awaited<ReturnType<typeof buildDetachedVerifier>>;

describe("detached file verifier", () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "odap-detached-"));
    invoke = await buildDetachedVerifier(dir);
  }, 30_000);
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  it("reads the synthetic file and separate pin outside the checkout", async () => {
    const { stdout, stderr } = await invoke(bundle, "t", "i", pin);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toMatchObject({ consistent: true, issuerAuthenticated: false,
      outcome: "cancelled", actualMicroUsd: 0, digest: (await readFile(pin, "utf8")).trimEnd() });
  });
  it.each([["other", "i"], ["t", "other"]])("rejects unintended scope %s/%s", async (tenant, intent) => {
    await expect(invoke(bundle, tenant, intent, pin)).rejects.toMatchObject({
      code: 1, stdout: "", stderr: expect.stringContaining("scope mismatch")
    });
  });
  it("rejects consistent changes to both monetary records against the retained pin", async () => {
    const data = JSON.parse(await readFile(bundle, "utf8"));
    data.bill.actualMicroUsd = data.settlement.actualMicroUsd = 12;
    const modified = join(dir, "modified.json");
    await writeFile(modified, JSON.stringify(data));
    await expect(invoke(modified, "t", "i", pin)).rejects.toMatchObject({
      code: 1, stdout: "", stderr: expect.stringContaining("checksum mismatch")
    });
  });
  it("requires an explicit pin and never supplies its own expected checksum", async () => {
    await expect(invoke(bundle, "t", "i")).rejects.toMatchObject({ code: 2, stdout: "" });
    for (const [label, value, error] of [
      ["malformed", "sha256:short", "Invalid pin"], ["wrong", "sha256:" + "0".repeat(64), "checksum mismatch"]
    ]) {
      const file = join(dir, label);
      await writeFile(file, value);
      await expect(invoke(bundle, "t", "i", file)).rejects.toMatchObject({
        code: 1, stdout: "", stderr: expect.stringContaining(error)
      });
    }
    await expect(invoke(bundle, "t", "i", join(dir, "absent.sha256"))).rejects.toMatchObject({ code: 1, stdout: "" });
  });
  it("never treats a nondelegated bundle as evidence for a named audience", async () => {
    await expect(invoke(bundle, "t", "i", pin, "--audience", "gateway")).rejects.toMatchObject({
      code: 1, stdout: "", stderr: expect.stringContaining("scope mismatch")
    });
    for (const args of [["--audience"], ["--unknown", "gateway"], ["--audience", " "]]) {
      await expect(invoke(bundle, "t", "i", pin, ...args)).rejects.toMatchObject({ code: 2, stdout: "" });
    }
  });
  it("rejects BOM, invalid UTF-8, oversized and malformed files without echoing private input", async () => {
    const valid = await readFile(bundle);
    const file = join(dir, "private-filename.json");
    for (const bytes of [Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), valid]),
      Buffer.from([0xff]), Buffer.alloc(4 * 1024 * 1024 + 1), Buffer.from('private-fixture-text')]) {
      await writeFile(file, bytes);
      await expect(invoke(file, "t", "i", pin)).rejects.toMatchObject({
        code: 1, stdout: "", stderr: expect.stringMatching(/^Unreadable or invalid evidence input\r?\n$/)
      });
    }
  });
});
