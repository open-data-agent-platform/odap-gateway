import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildDetachedVerifier } from "./fixtures/detached-verifier";
import { syntheticPostgresEvidenceJson } from "./fixtures/postgresql-evidence";
import { canonicalControlJson, sha256Text } from "../lib/control-objects";
import { postgresEvidenceMaxBytes } from "../lib/postgresql-evidence";

let directory: string, file: string, pin: string, json: string, invoke: Awaited<ReturnType<typeof buildDetachedVerifier>>;
describe("standalone PostgreSQL evidence verifier", () => {
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "odap-pg-verifier-")); file = join(directory, "bundle.json"); pin = join(directory, "pin.sha256");
    json = await syntheticPostgresEvidenceJson(); await writeFile(file, json); await writeFile(pin, await sha256Text(json));
    invoke = await buildDetachedVerifier(directory, "verify-postgresql-evidence");
  }, 30000);
  afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });
  it("runs detached with an independently retained checksum", async () => {
    const result = await invoke(file, "tenant-a", "request", "intent", pin);
    expect(result.stderr).toBe(""); expect(JSON.parse(result.stdout)).toMatchObject({ consistent: true,
      issuerAuthenticated: false, providerVerified: false, authorizationGranted: false, monetaryCost: "unpriced" });
  });
  it.each([["peer", "request", "intent"], ["tenant-a", "other", "intent"], ["tenant-a", "request", "other"]])("rejects scope %s/%s/%s", async (...scope) => {
    await expect(invoke(file, ...scope, pin)).rejects.toMatchObject({ code: 1, stdout: "", stderr: expect.stringContaining("scope mismatch") });
  });
  it("requires the pin instead of trusting an embedded checksum", async () => {
    await expect(invoke(file, "tenant-a", "request", "intent")).rejects.toMatchObject({ code: 2, stdout: "" });
  });
  it("rejects changed consistent records against the retained checksum", async () => {
    const data = JSON.parse(json); data.source.connectionDigest = "sha256:" + "b".repeat(64);
    const changed = join(directory, "changed.json"); await writeFile(changed, canonicalControlJson(data));
    await expect(invoke(changed, "tenant-a", "request", "intent", pin)).rejects.toMatchObject({ code: 1, stdout: "", stderr: expect.stringContaining("checksum mismatch") });
  });
  it("does not echo malformed data, invalid UTF-8, BOM or oversized files", async () => {
    const bad = join(directory, "private-name.json");
    for (const bytes of [Buffer.from("private-value"), Buffer.from([0xff]), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(json)]), Buffer.alloc(postgresEvidenceMaxBytes + 1)]) {
      await writeFile(bad, bytes);
      await expect(invoke(bad, "tenant-a", "request", "intent", pin)).rejects.toMatchObject({ code: 1, stdout: "", stderr: expect.stringMatching(/^Unreadable or invalid evidence input\r?\n$/) });
    }
  });
  it("rejects contradictory content even with its matching checksum", async () => {
    const data = JSON.parse(json); data.receipts[0].outcome = "succeeded";
    const bad = join(directory, "contradiction.json"), text = canonicalControlJson(data);
    await writeFile(bad, text); await writeFile(bad + ".sha256", await sha256Text(text));
    await expect(invoke(bad, "tenant-a", "request", "intent", bad + ".sha256")).rejects.toMatchObject({ code: 1, stdout: "" });
  });
});
