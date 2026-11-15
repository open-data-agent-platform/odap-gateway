import { canonicalControlJson, sha256Text } from "../../lib/control-objects";
import type { ControlAccess } from "../../lib/control-storage";
import { claimPostgresRead, observePostgresRead, preparePostgresDispatch, PostgresControlDenied } from "../../lib/postgresql-control";
import { executePostgresMetric, type PostgresHostConfig } from "./index";
import { verifyPostgresAgent, inspectPostgresAgent, type PostgresAgentProof, type PostgresAgentOperation } from "../../lib/postgresql-agent";
import type { D1Database } from "../../lib/d1";
import { recordPostgresFailure } from "../../lib/postgresql-terminal";

export type PostgresConnectionResolver = (tenantId: string, connectionRef: string) => Promise<PostgresHostConfig>;

// Persist only this digest in the trusted source registry, never credentials.
// Password rotation does not change authority; endpoint, role, TLS or limits do.
export async function postgresConnectionDigest(tenantId: string, config: PostgresHostConfig) {
  return sha256Text(canonicalControlJson({ tenantId, host: config.host, port: config.port, database: config.database,
    role: config.user, tls: "insecureLoopback" in config.tls ? "insecure-loopback-fixture" :
      { caDigest: config.tls.ca ? await sha256Text(config.tls.ca) : "system-trust", rejectUnauthorized: true },
    statementTimeoutMs: config.statementTimeoutMs, lockTimeoutMs: config.lockTimeoutMs, deadlineMs: config.deadlineMs }));
}

async function bounded<T>(promise: Promise<T>, ms = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new PostgresControlDenied()), ms);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

// The trusted resolver is never selected by a client-supplied host, URL, role or password.
export async function executeGovernedPostgresRead(access: ControlAccess, requestId: string,
  resolve: PostgresConnectionResolver, signal?: AbortSignal, proof?: PostgresAgentProof) {
  const { row, compiled, read } = await bounded(preparePostgresDispatch(access, requestId, proof));
  const resolved = await bounded(resolve(access.tenantId, row.connection_ref));
  const config = { ...resolved, tls: { ...resolved.tls } };
  if (signal?.aborted || config.user !== row.role_name || config.database !== read.source.database ||
      await postgresConnectionDigest(access.tenantId, config) !== row.connection_digest) throw new PostgresControlDenied();
  const intentId = crypto.randomUUID();
  const result = await executePostgresMetric(config, read, async binding => {
    if (signal?.aborted || binding.database !== read.source.database || binding.role !== row.role_name ||
        binding.actionDigest !== compiled.actionDigest || binding.definitionDigest !== compiled.definitionDigest ||
        binding.statementDigest !== compiled.statementDigest) return false;
    return bounded(claimPostgresRead(access, row, intentId, proof));
  }, signal);
  if (result.claim !== "confirmed") {
    return { outcome: result.claim === "unknown" ? "observation-required" : "not-submitted",
      claim: result.claim, requestId, monetaryCost: "unpriced" as const };
  }
  let recorded = false;
  try {
    recorded = result.outcome === "failed" ? await bounded(recordPostgresFailure(access, requestId, intentId,
      result.statementDigest, result.sqlState)) : await bounded(observePostgresRead(access, requestId, intentId,
      result.outcome === "succeeded" ? "succeeded" : "observation-required"));
  } catch { /* The pending receipt remains authoritative when observation acknowledgement is lost. */ }
  if (recorded && result.outcome === "failed") return { outcome: "failed", claim: "confirmed", requestId, intentId,
    sqlState: result.sqlState, receiptId: "pg-failed-" + intentId, monetaryCost: "unpriced" as const };
  if (!recorded || result.outcome !== "succeeded") {
    return { outcome: "observation-required", claim: "confirmed", requestId, intentId, monetaryCost: "unpriced" as const };
  }
  return { outcome: "succeeded", claim: "confirmed", requestId, intentId, value: result.value,
    receiptId: "pg-observed-" + intentId, statementDigest: compiled.statementDigest, monetaryCost: "unpriced" as const };
}

export async function postgresAgentOperation(db: D1Database, audience: string, tenantId: string,
  delegationId: string, signature: string, operation: PostgresAgentOperation, resolve: PostgresConnectionResolver, signal?: AbortSignal) {
  const verified = await bounded(verifyPostgresAgent(db, audience, tenantId, delegationId, signature, operation));
  return operation === "inspect" ? bounded(inspectPostgresAgent(verified.access, verified.proof)) :
    executeGovernedPostgresRead(verified.access, verified.requestId, resolve, signal, verified.proof);
}
