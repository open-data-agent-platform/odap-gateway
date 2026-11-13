import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { readbackJson, verifyWorkerDeployment } from "../scripts/worker-deployment-readback.mjs";

const target = { configPath: "synthetic.json", accountId: "a".repeat(32), workerName: "fixture-gateway",
  deploymentId: "11111111-1111-1111-1111-111111111111", versionId: "22222222-2222-2222-2222-222222222222" };
const config = JSON.stringify({ name: target.workerName, account_id: target.accountId });
const user = () => ({ loggedIn: true, accounts: [{ id: target.accountId }], email: "synthetic@example.test" });
const deployment = () => ({ id: target.deploymentId, created_on: "2026-01-02T03:04:05.123456Z",
  versions: [{ version_id: target.versionId, percentage: 100 }] });
const ok = data => ({ status: 0, signal: null, stdout: JSON.stringify(data) });
const fixtures = (identity = user(), list = [deployment()]) => ({
  readConfig: vi.fn(() => config), run: vi.fn().mockReturnValueOnce(ok(identity)).mockReturnValueOnce(ok(list)), steps: []
});

describe("read-only Worker deployment verification", () => {
  it("checks structured identity and the newest deployment without trusting array order", () => {
    const older = { ...deployment(), id: "33333333-3333-3333-3333-333333333333", created_on: "2025-12-31T00:00:00Z" };
    const f = fixtures(user(), [deployment(), older]);
    expect(verifyWorkerDeployment(target, f)).toMatchObject({ accountId: target.accountId, workerName: target.workerName,
      deploymentId: target.deploymentId, versionId: target.versionId, percentage: 100, configSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(f.run.mock.calls).toEqual([
      [["whoami", "--json", "--config", target.configPath]],
      [["deployments", "list", "--name", target.workerName, "--json", "--config", target.configPath]]
    ]);
    expect(f.steps).toHaveLength(2); expect(f.steps.every(s => s.normalExit)).toBe(true);
    expect(JSON.stringify(f.steps)).not.toContain("synthetic@example.test");
  });
  it.each(["accountId", "workerName", "deploymentId", "versionId", "configPath"])("rejects an absent %s before any CLI call", field => {
    const f = fixtures(); expect(() => verifyWorkerDeployment({ ...target, [field]: undefined }, f)).toThrow("target_invalid");
    expect(f.run).not.toHaveBeenCalled();
  });
  it.each(["not json", "null", "{}", JSON.stringify({ name: "other", account_id: target.accountId }),
    JSON.stringify({ name: target.workerName, account_id: "b".repeat(32) })])("rejects unsupported or mismatched config %s before remote reads", text => {
    const f = fixtures(); f.readConfig.mockReturnValue(text);
    expect(() => verifyWorkerDeployment(target, f)).toThrow(); expect(f.run).not.toHaveBeenCalled();
  });
  it.each([null, {}, { ...user(), loggedIn: "true" }, { ...user(), loggedIn: false }, { ...user(), accounts: [] },
    { ...user(), accounts: [{ id: "b".repeat(32) }] }, { ...user(), accounts: [{ id: target.accountId }, { id: target.accountId }] }])(
    "refuses unconfirmed account %j without requesting deployment metadata", identity => {
      const f = fixtures(identity); expect(() => verifyWorkerDeployment(target, f)).toThrow("account_mismatch");
      expect(f.run).toHaveBeenCalledTimes(1);
    });
  it.each([null, {}, [], [{ ...deployment(), id: "invalid" }], [deployment(), deployment()],
    [{ ...deployment(), created_on: "yesterday" }], [{ ...deployment(), created_on: "2099-99-99T99:99:99Z" }]])(
    "refuses incomplete or ambiguous deployment history %j", list => {
      expect(() => verifyWorkerDeployment(target, fixtures(user(), list))).toThrow("deployments_invalid");
    });
  it("does not accept the expected deployment when a newer deployment exists", () => {
    const newer = { ...deployment(), id: "33333333-3333-3333-3333-333333333333", created_on: "2026-02-01T00:00:00Z" };
    expect(() => verifyWorkerDeployment(target, fixtures(user(), [newer, deployment()]))).toThrow("deployment_mismatch");
  });
  it("refuses equal newest timestamps instead of guessing the active deployment", () => {
    const peer = { ...deployment(), id: "33333333-3333-3333-3333-333333333333" };
    expect(() => verifyWorkerDeployment(target, fixtures(user(), [deployment(), peer]))).toThrow("deployment_mismatch");
  });
  it.each([null, [], [{ version_id: target.versionId, percentage: 50 }], [{ version_id: target.versionId, percentage: "100" }],
    [{ version_id: "other", percentage: 100 }], [...deployment().versions, ...deployment().versions]])(
    "refuses a missing, different or split version %j", versions => {
      expect(() => verifyWorkerDeployment(target, fixtures(user(), [{ ...deployment(), versions }]))).toThrow("version_mismatch");
    });
  it("rejects a configuration edit during readback", () => {
    const f = fixtures(); f.readConfig.mockReturnValueOnce(config).mockReturnValueOnce(config + "\n");
    expect(() => verifyWorkerDeployment(target, f)).toThrow("config_changed");
  });
  it("does not include raw process diagnostics in a failure record", () => {
    const steps = [];
    expect(() => readbackJson({ status: 0, signal: null, stdout: "private-output", stderr: "private-diagnostic",
      error: { code: "private-code", message: "private-message" } }, "whoami", steps)).toThrow(/^worker_readback_process_failed$/);
    expect(JSON.stringify(steps)).not.toContain("private");
  });
  it.each([{ status: 1 }, { status: null }, { signal: "SIGTERM" }, { error: { code: "ETIMEDOUT" } },
    { error: { code: "ENOBUFS" } }])("rejects valid JSON after an abnormal process result %j", change => {
    const f = fixtures(); f.run.mockReset().mockReturnValue({ ...ok(user()), ...change });
    expect(() => verifyWorkerDeployment(target, f)).toThrow("process_failed"); expect(f.run).toHaveBeenCalledTimes(1);
  });
  it.each([["empty", ""], ["diagnostic", "private diagnostic"], ["multiple values", "{}\n{}"],
    ["oversized", "x".repeat(1024 * 1024 + 1)]])("rejects %s output without revealing it", (_label, stdout) => {
    expect(() => readbackJson({ status: 0, signal: null, stdout }, "whoami", [])).toThrow(/^worker_readback_output_invalid$/);
  });
  it("requires successful process completion even when a real child printed valid JSON", () => {
    const child = spawnSync(process.execPath, ["-e", "console.log('{}');process.exitCode=1"], { encoding: "utf8", windowsHide: true });
    expect(() => readbackJson(child, "whoami", [])).toThrow("process_failed");
  });
  it("rejects a real timed-out child rather than accepting its earlier output", () => {
    const child = spawnSync(process.execPath, ["-e", "console.log('{}');setInterval(()=>{},1000)"],
      { encoding: "utf8", windowsHide: true, timeout: 1000 });
    expect(child.error?.code).toBe("ETIMEDOUT");
    expect(() => readbackJson(child, "whoami", [])).toThrow("process_failed");
  });
});
