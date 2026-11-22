import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildDetachedVerifier } from "./fixtures/detached-verifier";
import { canonicalControlJson, sha256Text } from "../lib/control-objects";
import { postgresDenialEvidenceMaxBytes } from "../lib/postgresql-denial-evidence";
import { postgresDenialScope as scope, syntheticPostgresDenialJson } from "./fixtures/postgresql-denial-evidence";

let directory: string, file: string, pin: string, json: string, invoke: Awaited<ReturnType<typeof buildDetachedVerifier>>;
describe("detached PostgreSQL denial verifier", () => {
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "odap-pg-denial-cli-")); file = join(directory, "bundle.json"); pin = join(directory, "pin.sha256");
    json = syntheticPostgresDenialJson(); await writeFile(file, json); await writeFile(pin, await sha256Text(json));
    invoke = await buildDetachedVerifier(directory, "verify-postgresql-denial");
  }, 30000);
  afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });
  it("verifies detached from the repository without issuer or execution claims", async () => {
    const result = await invoke(file, scope.tenantId, scope.attemptId, pin);
    expect(result.stderr).toBe(""); expect(JSON.parse(result.stdout)).toMatchObject({ consistent: true, recordedDecision: "denied",
      issuerAuthenticated: false, executionVerified: false, authorizationGranted: false, actionValuesVerified: false });
  });
  it.each([["peer", scope.attemptId], [scope.tenantId, "pg-missing-12345678-1234-4234-8234-123456789abd"]])("rejects scope %s/%s", async (...selected) => {
    await expect(invoke(file, ...selected, pin)).rejects.toMatchObject({ code: 1, stdout: "", stderr: expect.stringContaining("scope mismatch") });
  });
  it("requires an independently retained pin", async () => {
    await expect(invoke(file, scope.tenantId, scope.attemptId)).rejects.toMatchObject({ code: 2, stdout: "" });
  });
  it("rejects internally consistent replacement against the retained pin", async () => {
    const data = JSON.parse(json); data.denial.requestedRelease = "different";
    const changed = join(directory, "changed.json"); await writeFile(changed, canonicalControlJson(data));
    await expect(invoke(changed, scope.tenantId, scope.attemptId, pin)).rejects.toMatchObject({ code: 1, stdout: "", stderr: expect.stringContaining("checksum mismatch") });
  });
  it("rejects contradictions even with a matching pin", async () => {
    const data = JSON.parse(json); data.receipt.contractId = "unapproved";
    const bad = join(directory, "contradictory.json"), text = canonicalControlJson(data);
    await writeFile(bad, text); await writeFile(bad + ".sha256", await sha256Text(text));
    await expect(invoke(bad, scope.tenantId, scope.attemptId, bad + ".sha256")).rejects.toMatchObject({ code: 1, stdout: "" });
  });
  it("does not echo private paths, malformed bytes, BOM or oversized files", async () => {
    const bad = join(directory, "private-name.json");
    for (const bytes of [Buffer.from("private-value"), Buffer.from([0xff]), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(json)]),
      Buffer.alloc(postgresDenialEvidenceMaxBytes + 1)]) {
      await writeFile(bad, bytes);
      await expect(invoke(bad, scope.tenantId, scope.attemptId, pin)).rejects.toMatchObject({ code: 1, stdout: "",
        stderr: expect.stringMatching(/^Unreadable or invalid evidence input\r?\n$/) });
    }
  });
  it("refuses malformed and missing pin files without exposing their contents", async () => {
    const bad = join(directory, "private-pin"); await writeFile(bad, "private-pin-value");
    await expect(invoke(file, scope.tenantId, scope.attemptId, bad)).rejects.toMatchObject({ code: 1, stdout: "", stderr: "Invalid pin\n" });
    await expect(invoke(file, scope.tenantId, scope.attemptId, bad + ".absent")).rejects.toMatchObject({ code: 1, stdout: "",
      stderr: expect.stringMatching(/^Unreadable or invalid evidence input\r?\n$/) });
  });
});
