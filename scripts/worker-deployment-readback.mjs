import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const hash = text => createHash("sha256").update(text).digest("hex");
const fail = code => { throw new Error(`worker_readback_${code}`); };

export function readbackJson(result, label, steps) {
  const normal = result?.status === 0 && result.signal === null && !result.error;
  steps.push({ command: label, exitCode: Number.isInteger(result?.status) ? result.status : null,
    signal: result?.signal ? "terminated" : null, normalExit: normal,
    processError: result?.error ? (["ETIMEDOUT", "ENOBUFS", "ENOENT", "EACCES"].includes(result.error.code)
      ? result.error.code : "process_error") : null });
  if (!normal) fail("process_failed");
  if (typeof result.stdout !== "string" || Buffer.byteLength(result.stdout) > 1024 * 1024) fail("output_invalid");
  try { return JSON.parse(result.stdout); } catch { fail("output_invalid"); }
}

export function verifyWorkerDeployment(expected, { run, readConfig = path => readFileSync(path, "utf8"), steps = [] } = {}) {
  const { configPath, accountId, workerName, deploymentId, versionId } = expected;
  if (typeof configPath !== "string" || !configPath || !/^[a-f0-9]{32}$/.test(accountId ?? "") ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/.test(workerName ?? "") ||
      !uuid.test(deploymentId ?? "") || !uuid.test(versionId ?? "")) fail("target_invalid");
  let text, config;
  try { text = readConfig(configPath); config = JSON.parse(text); } catch { fail("config_invalid"); }
  if (config?.account_id !== accountId || config?.name !== workerName) fail("config_target_mismatch");
  const require = createRequire(import.meta.url);
  // The installed launcher maps a signalled child to exit zero. Observe the CLI itself.
  const cli = join(dirname(require.resolve("wrangler/package.json")), "wrangler-dist/cli.js");
  const invoke = run ?? (args => spawnSync(process.execPath, ["--no-warnings", "--experimental-vm-modules", cli, ...args], {
    encoding: "utf8", windowsHide: true, timeout: 90000, maxBuffer: 1024 * 1024,
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId, WRANGLER_SEND_METRICS: "false" }
  }));
  const call = (label, args) => {
    let result;
    try { result = invoke(args); } catch { fail("process_failed"); }
    return readbackJson(result, label, steps);
  };
  const user = call("whoami", ["whoami", "--json", "--config", configPath]);
  if (user?.loggedIn !== true || !Array.isArray(user.accounts) ||
      user.accounts.filter(account => account?.id === accountId).length !== 1) fail("account_mismatch");
  const deployments = call("deployments list", ["deployments", "list", "--name", workerName, "--json", "--config", configPath]);
  if (!Array.isArray(deployments) || !deployments.length) fail("deployments_invalid");
  const ids = new Set();
  for (const deployment of deployments) {
    if (!uuid.test(deployment?.id ?? "") || ids.has(deployment.id) ||
        typeof deployment.created_on !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(deployment.created_on) ||
        !Number.isFinite(Date.parse(deployment.created_on))) fail("deployments_invalid");
    ids.add(deployment.id);
  }
  const latestTime = Math.max(...deployments.map(d => Date.parse(d.created_on)));
  const latest = deployments.filter(d => Date.parse(d.created_on) === latestTime);
  if (latest.length !== 1 || latest[0].id !== deploymentId) fail("deployment_mismatch");
  const deployment = latest[0];
  if (!Array.isArray(deployment.versions) || deployment.versions.length !== 1 ||
      deployment.versions[0]?.version_id !== versionId || deployment.versions[0]?.percentage !== 100) fail("version_mismatch");
  let after;
  try { after = readConfig(configPath); } catch { fail("config_changed"); }
  if (after !== text) fail("config_changed");
  return { accountId, workerName, deploymentId, versionId, percentage: 100,
    deployedAt: deployment.created_on, configSha256: hash(text), checkedAt: new Date().toISOString() };
}

function main() {
  const { values } = parseArgs({ strict: true, allowPositionals: false,
    options: Object.fromEntries(["config", "account", "worker", "deployment", "version"].map(name => [name, { type: "string" }])) });
  const root = fileURLToPath(new URL("../", import.meta.url));
  const parent = join(root, ".tmp/verification"); mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, "worker-readback-"));
  const evidence = { schemaVersion: 1, startedAt: new Date().toISOString(), passed: false, steps: [] };
  try {
    const snapshot = verifyWorkerDeployment({ configPath: values.config && resolve(values.config), accountId: values.account,
      workerName: values.worker, deploymentId: values.deployment, versionId: values.version }, { steps: evidence.steps });
    Object.assign(evidence, snapshot, { passed: true });
  } catch (error) {
    evidence.error = /^worker_readback_[a-z_]+$/.test(error.message) ? error.message : "worker_readback_unavailable";
    process.exitCode = 1;
  } finally {
    writeFileSync(join(directory, "readback.json"), JSON.stringify(evidence, null, 2) + "\n", { flag: "wx" });
    console.log(JSON.stringify({ passed: evidence.passed, evidence: join(directory, "readback.json") }));
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { main(); } catch { console.error("worker_readback_unavailable"); process.exitCode = 1; }
}
