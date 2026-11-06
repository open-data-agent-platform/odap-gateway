import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export function checkNativeRuntime(version, platform) {
  const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error("Cannot confirm the native-test Node version");
  const [major, minor, patch] = match.slice(1).map(Number);
  // This Windows test profile was validated after 24.15.0 aborted native runs.
  if (platform === "win32" && (major !== 24 || minor < 22 || (minor === 22 && patch < 1))) {
    throw new Error("Windows native D1 tests require Node 24.22.1+ in the 24.x line; set ODAP_TEST_NODE to that executable");
  }
}

export function validateNativeReport(report, { code, signal, files, root }) {
  if (code !== 0 || signal) throw new Error("Native test process did not exit successfully");
  const expected = new Set(files.map(file => resolve(root, file)));
  if (!files.length || expected.size !== files.length) throw new Error("Invalid native suite inventory");
  if (report?.success !== true || !Number.isSafeInteger(report.numTotalTests) || report.numTotalTests <= 0 ||
      report.numPassedTests !== report.numTotalTests || report.numFailedTests !== 0 ||
      report.numPendingTests !== 0 || report.numTodoTests !== 0 || report.numFailedTestSuites !== 0 ||
      report.numPendingTestSuites !== 0 || report.snapshot?.failure === true ||
      !Array.isArray(report.testResults) || report.testResults.length !== expected.size) {
    throw new Error("Native test report is incomplete or unsuccessful");
  }
  let count = 0;
  for (const suite of report.testResults) {
    if (typeof suite?.name !== "string" || !expected.delete(resolve(root, suite.name)) ||
        suite.status !== "passed" || !Array.isArray(suite.assertionResults) || !suite.assertionResults.length) {
      throw new Error("Native suite results do not match the requested inventory");
    }
    const names = new Set();
    for (const assertion of suite.assertionResults) {
      if (assertion?.status !== "passed" || typeof assertion.fullName !== "string" || !assertion.fullName ||
          names.has(assertion.fullName) || !Array.isArray(assertion.failureMessages) || assertion.failureMessages.length) {
        throw new Error("Native report contains an unconfirmed test result");
      }
      names.add(assertion.fullName);
      count += 1;
    }
  }
  if (expected.size || count !== report.numTotalTests) throw new Error("Native test counts do not reconcile");
  return { files: files.length, tests: count };
}

function main() {
  if (process.argv.length !== 2) throw new Error("The native D1 gate does not accept filters or runner overrides");
  const root = fileURLToPath(new URL("../", import.meta.url));
  const node = process.env.ODAP_TEST_NODE || process.execPath;
  const probe = spawnSync(node, ["--version"], { encoding: "utf8", windowsHide: true });
  if (probe.error || probe.status !== 0 || probe.signal) throw new Error("Cannot start the selected native-test Node executable");
  const version = probe.stdout.trim();
  checkNativeRuntime(version, process.platform);
  const files = readdirSync(join(root, "tests")).filter(file => file.endsWith("-miniflare.test.ts"))
    .sort().map(file => `tests/${file}`);
  if (!files.length) throw new Error("No native D1 suites found");
  const require = createRequire(import.meta.url);
  const cli = join(dirname(require.resolve("vitest/package.json")), "vitest.mjs");
  const evidenceRoot = join(root, ".tmp", "verification");
  mkdirSync(evidenceRoot, { recursive: true });
  const directory = mkdtempSync(join(evidenceRoot, "native-d1-gate-"));
  const reportPath = join(directory, "vitest.json");
  const args = [cli, "run", "--environment", "node", "--pool=forks", "--maxWorkers=1", "--minWorkers=1",
    "--reporter=default", "--reporter=json", `--outputFile=${reportPath}`, ...files];
  console.log(`Native D1 gate: ${version}, ${files.length} files; evidence: ${directory}`);
  const child = spawnSync(node, args, { cwd: root, stdio: "inherit", windowsHide: true });
  const evidence = { nodeVersion: version, platform: process.platform, files, exitCode: child.status,
    signal: child.signal, checkedAt: new Date().toISOString(), passed: false };
  try {
    if (child.error) throw new Error("Native test process could not complete");
    if (child.status !== 0 || child.signal) throw new Error("Native test process did not exit successfully");
    const summary = validateNativeReport(JSON.parse(readFileSync(reportPath, "utf8")),
      { code: child.status, signal: child.signal, files, root });
    evidence.passed = true;
    console.log(`Native D1 gate passed: ${summary.tests} tests in ${summary.files} files`);
  } catch (error) {
    evidence.error = error.message;
    throw error;
  } finally {
    writeFileSync(join(directory, "gate.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { main(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
