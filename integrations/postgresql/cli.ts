import { parseArgs } from "node:util";
import { readPostgresHostFile, parsePostgresHostConfig, postgresHostConfigSummary } from "./host-config";

async function main() {
  const { values, positionals, tokens } = parseArgs({ strict: true, allowPositionals: true, tokens: true, options: { config: { type: "string" } } });
  if (tokens.filter(token => token.kind === "option").length !== 1 || positionals.length !== 1 ||
      !["check", "serve"].includes(positionals[0]) || !values.config) throw new Error("Invalid command");
  if (positionals[0] === "check") {
    const config = parsePostgresHostConfig(readPostgresHostFile(values.config));
    process.stdout.write(JSON.stringify({ ok: true, ...postgresHostConfigSummary(config) }) + "\n"); return;
  }
  if (process.versions.node !== "24.22.1") throw new Error("Unsupported runtime");
  const { startConfiguredPostgresHost } = await import("./host.js");
  const host = await startConfiguredPostgresHost(values.config, process.env);
  let stopping = false;
  const stop = () => {
    if (stopping) return; stopping = true;
    void (async () => {
      // A transport deadline is not proof that provider/storage work has ended.
      // Keep the ledger alive until the host confirms all handlers have drained.
      let result = await host.close();
      if (!result.drained) process.stdout.write(JSON.stringify({ event: "draining", drained: false }) + "\n");
      while (!result.drained) {
        await new Promise(resolve => setTimeout(resolve, 250)); result = await host.close(1000);
      }
      process.off("SIGINT", stop); process.off("SIGTERM", stop);
      process.stdout.write(JSON.stringify({ event: "stopped", drained: true }) + "\n");
    })().catch(() => { process.stderr.write("PostgreSQL host shutdown unconfirmed\n"); process.exitCode = 1; });
  };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  process.stdout.write(JSON.stringify({ event: "ready", address: host.address, connections: host.bindings.length }) + "\n");
}

void main().catch(() => {
  process.stderr.write("PostgreSQL host unavailable; verify the explicit configuration and runtime\n");
  process.exitCode = 1;
});
