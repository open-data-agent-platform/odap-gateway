import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canonicalControlJson, sha256Text } from "../lib/control-objects";
import { buildDetachedVerifier } from "./fixtures/detached-verifier";

const bundle = resolve("tests/fixtures/settled-job.json");
const pin = resolve("tests/pins/settled-job.sha256");
const namespace = "https://gateway.example/gateway";
let dir: string;
let invoke: Awaited<ReturnType<typeof buildDetachedVerifier>>;

describe("detached OpenLineage CLI", () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "odap-openlineage-"));
    invoke = await buildDetachedVerifier(dir, "export-openlineage");
  }, 30_000);
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });
  it("emits exactly two NDJSON events outside the checkout without runtime dependencies", async () => {
    const { stdout, stderr } = await invoke(bundle, "t", "i", pin, namespace);
    expect(stderr).toBe("");
    const events = stdout.trimEnd().split("\n").map(line => JSON.parse(line));
    expect(events.map(e => e.eventType)).toEqual(["START", "ABORT"]);
    expect(events[1].run.facets.odap_evidence.issuerAuthenticated).toBe(false);
  });
  it("reports usage errors without emitting any events", async () => {
    for (const args of [[], [bundle, "t", "i", pin], [bundle, "t", "i", pin, namespace, "--extra"]]) {
      await expect(invoke(...args)).rejects.toMatchObject({ code: 2, stdout: "" });
    }
    expect((await invoke("--help")).stdout).toContain("Usage:");
  });
  it.each([["other", "i"], ["t", "other"]])("rejects %s/%s without partial START", async (tenant, intent) => {
    await expect(invoke(bundle, tenant, intent, pin, namespace)).rejects.toMatchObject({ code: 1, stdout: "" });
  });
  it("requires a matching pin and expected delegation audience", async () => {
    const wrongPin = join(dir, "wrong.sha256");
    await writeFile(wrongPin, "sha256:" + "0".repeat(64));
    await expect(invoke(bundle, "t", "i", wrongPin, namespace)).rejects.toMatchObject({ code: 1, stdout: "" });
    await expect(invoke(bundle, "t", "i", pin, namespace, "--audience", "another")).rejects.toMatchObject({ code: 1, stdout: "" });
  });
  it("refuses unknown outcomes with a matching pin", async () => {
    const data = JSON.parse(await readFile(bundle, "utf8"));
    data.final.outcome = data.observation.outcome = "unknown";
    const json = canonicalControlJson(data), path = join(dir, "unknown.json");
    await writeFile(path, json);
    await writeFile(path + ".sha256", await sha256Text(json));
    await expect(invoke(path, "t", "i", path + ".sha256", namespace)).rejects.toMatchObject({ code: 1, stdout: "" });
  });
  it("rejects malformed, BOM, invalid UTF-8 and oversized files without echoing input", async () => {
    const original = await readFile(bundle);
    for (const [name, bytes] of [
      ["malformed", Buffer.from('{"private":"PRIVATE-CONTENT"')],
      ["bom", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), original])],
      ["utf8", Buffer.from([0xc3, 0x28])], ["large", Buffer.alloc(4 * 1024 * 1024 + 1, 32)]
    ] as const) {
      const file = join(dir, name);
      await writeFile(file, bytes);
      await expect(invoke(file, "t", "i", pin, namespace)).rejects.toMatchObject({
        code: 1, stdout: "", stderr: expect.stringMatching(/^Unreadable or invalid evidence input\r?\n$/)
      });
    }
  });
  it("does not echo namespace credentials", async () => {
    await expect(invoke(bundle, "t", "i", pin, "https://private:password@example.org/"))
      .rejects.toMatchObject({ code: 1, stdout: "", stderr: expect.not.stringContaining("password") });
  });
});
