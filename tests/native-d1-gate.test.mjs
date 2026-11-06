import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { checkNativeRuntime, validateNativeReport } from "../scripts/native-d1-gate.mjs";

const files = ["tests/first-miniflare.test.ts", "tests/second-miniflare.test.ts"];
const context = { code: 0, signal: null, files, root: process.cwd() };
function valid() {
  return {
    success: true, numTotalTests: 2, numPassedTests: 2, numFailedTests: 0,
    numPendingTests: 0, numTodoTests: 0, numFailedTestSuites: 0, numPendingTestSuites: 0,
    snapshot: { failure: false },
    testResults: files.map(name => ({ name: resolve(context.root, name), status: "passed",
      assertionResults: [{ fullName: "native case", status: "passed", failureMessages: [] }] }))
  };
}

describe("native D1 verification gate", () => {
  it("accepts a complete unfiltered inventory with normal process exit", () => {
    expect(validateNativeReport(valid(), context)).toEqual({ files: 2, tests: 2 });
  });
  it.each([1, 3221226505, null])("rejects exit %s despite success:true", code => {
    expect(() => validateNativeReport(valid(), { ...context, code })).toThrow();
  });
  it("rejects a termination signal even alongside exit zero", () => {
    expect(() => validateNativeReport(valid(), { ...context, signal: "SIGTERM" })).toThrow();
  });
  it.each([
    ["success", false], ["success", "true"], ["numTotalTests", 0], ["numTotalTests", 3],
    ["numPassedTests", 1], ["numFailedTests", 1], ["numPendingTests", 1],
    ["numTodoTests", 1], ["numFailedTestSuites", 1], ["numPendingTestSuites", 1]
  ])("rejects an invalid summary field %s=%s", (field, value) => {
    expect(() => validateNativeReport({ ...valid(), [field]: value }, context)).toThrow();
  });
  it.each([null, {}, { success: true }])("rejects a missing or truncated report: %j", report => {
    expect(() => validateNativeReport(report, context)).toThrow();
  });
  it.each([[], [files[0], files[0]]])("rejects an empty or duplicate expected inventory: %j", inventory => {
    expect(() => validateNativeReport(valid(), { ...context, files: inventory })).toThrow();
  });
  it.each([
    ["missing suite", report => report.testResults.pop()],
    ["substituted suite", report => { report.testResults[0].name = "tests/unknown.test.ts"; }],
    ["duplicate suite", report => { report.testResults[1] = report.testResults[0]; }],
    ["failed suite", report => { report.testResults[0].status = "failed"; }],
    ["empty suite", report => { report.testResults[0].assertionResults = []; }],
    ["pending test", report => { report.testResults[0].assertionResults[0].status = "pending"; }],
    ["failure detail", report => { report.testResults[0].assertionResults[0].failureMessages = ["failure"]; }],
    ["duplicate test", report => { report.testResults[0].assertionResults.push(report.testResults[0].assertionResults[0]); }],
    ["inflated count", report => { report.numTotalTests = report.numPassedTests = 3; }],
    ["snapshot failure", report => { report.snapshot.failure = true; }]
  ])("rejects %s despite success:true", (_label, change) => {
    const report = valid();
    change(report);
    expect(() => validateNativeReport(report, context)).toThrow();
  });
  it.each(["v24.15.0", "v24.22.0", "v22.23.0", "v26.0.0", "unknown"])(
    "refuses an unverified Windows native-test runtime %s", version => {
      expect(() => checkNativeRuntime(version, "win32")).toThrow();
    });
  it.each(["v24.22.1", "v24.22.2", "v24.23.0"])("accepts the validated Windows runtime line %s", version => {
    expect(() => checkNativeRuntime(version, "win32")).not.toThrow();
  });
  it("does not impose the Windows profile on the existing Linux CI runtime", () => {
    expect(() => checkNativeRuntime("v20.19.0", "linux")).not.toThrow();
  });
});
