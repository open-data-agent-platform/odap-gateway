import { basename, dirname } from "node:path";
import type { D1Database } from "../../lib/d1";
import type { PostgresHostConfig } from "../../integrations/postgresql";
import { executeGovernedPostgresRead, postgresAgentOperation } from "../../integrations/postgresql/control";
import { inspectPostgresRead } from "../../lib/postgresql-control";
import { pgAccess } from "./postgresql-control";
import { pgAgentOrigin } from "./postgresql-agent";
import { jobTransactionalDatabase } from "./job-sqlite";

export type PostgresCrashInput = {
  file: string; phase: "claim-ack" | "query-running" | "observation-ack" | "terminal-ack";
  mode: "execute" | "recover"; config: PostgresHostConfig;
  agent?: { delegationId: string; signature: string; inspectSignature: string };
};
const send = (message: unknown) => new Promise<void>((resolve, reject) => {
  process.send!(message, error => error ? reject(error) : resolve());
});
async function checkpoint(phase: string) {
  await send({ checkpoint: phase });
  await new Promise<void>(() => { /* Parent deliberately kills this process before acknowledgement. */ });
}
async function main(input: PostgresCrashInput) {
  if (process.env.ODAP_POSTGRES_FIXTURE !== "isolated-synthetic-only" || !process.send ||
      basename(input.file) !== "ledger.db" || !basename(dirname(input.file)).startsWith("odap-pg-governed-") ||
      input.config.host !== "127.0.0.1" || input.config.port !== 55432 || input.config.database !== "odap_pg_fixture" ||
      input.config.user !== "reader_a" || input.config.password !== "synthetic-fixture-only") throw new Error("Invalid synthetic crash fixture");
  const base = jobTransactionalDatabase(() => input.file);
  const request = input.agent ? "agent-request" : "request";
  if (input.mode === "recover") {
    let resolverCalls = 0, refused = false;
    const resolve = async () => { resolverCalls++; throw new Error("Recovery must not contact PostgreSQL"); };
    const inspected = await inspectPostgresRead(pgAccess(base), request);
    const agentInspection = input.agent ? await postgresAgentOperation(base, pgAgentOrigin, "tenant-a", input.agent.delegationId,
      input.agent.inspectSignature, "inspect", resolve) : null;
    try {
      if (input.agent) await postgresAgentOperation(base, pgAgentOrigin, "tenant-a", input.agent.delegationId, input.agent.signature, "execute", resolve);
      else await executeGovernedPostgresRead(pgAccess(base), request, resolve);
    } catch { refused = true; }
    await send({ recovered: true, inspected, agentInspection, refused, resolverCalls });
    return;
  }
  const db: D1Database = { prepare(sql) {
    const prepared = base.prepare(sql);
    return { ...prepared, bind(...values) {
      const statement = prepared.bind(...values);
      return { ...statement, async first<T>() {
        const value = await statement.first<T>();
        if (input.phase === "claim-ack" && sql.startsWith("INSERT INTO postgresql_read_claims")) await checkpoint(input.phase);
        if (input.phase === "observation-ack" && sql.startsWith("INSERT INTO postgresql_read_observations")) await checkpoint(input.phase);
        if (input.phase === "terminal-ack" && sql.startsWith("INSERT INTO postgresql_terminal_failures")) await checkpoint(input.phase);
        return value;
      } };
    } };
  } };
  const result = input.agent ? await postgresAgentOperation(db, pgAgentOrigin, "tenant-a", input.agent.delegationId,
    input.agent.signature, "execute", async () => input.config) : await executeGovernedPostgresRead(pgAccess(db), request, async () => input.config);
  await send({ unexpectedCompletion: result.outcome });
}
process.once("message", input => {
  void main(input as PostgresCrashInput).then(() => process.disconnect(), async () => {
    process.exitCode = 1;
    await send({ fixtureError: true }).catch(() => undefined);
    if (process.connected) process.disconnect();
  });
});
setTimeout(() => process.exit(2), 20000).unref();
