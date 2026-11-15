import { X509Certificate } from "node:crypto";
import { readPostgresHostFile, parsePostgresHostConfig, PostgresHostConfigurationError, type PostgresHostFile } from "./host-config";
import { postgresConnectionDigest, type PostgresConnectionResolver } from "./control";
import type { PostgresHostConfig } from "./index";
import { openPostgresSqliteControl } from "./sqlite-control";
import { startPostgresHttpHost } from "./server";

function unavailable(): never { throw new PostgresHostConfigurationError(); }
type SecretEnvironment = Readonly<Record<string, string | undefined>>;
function secret(environment: SecretEnvironment, name: string, minimum: number): string {
  const value = Object.hasOwn(environment, name) ? environment[name] : undefined;
  if (typeof value !== "string" || Buffer.byteLength(value) < minimum || Buffer.byteLength(value) > 8192 || value.includes("\0")) unavailable();
  return value;
}

/** Resolve only the operator's explicit (tenant, reference) map. Never consult PG* defaults. */
export async function configuredPostgresConnections(config: PostgresHostFile, environment: SecretEnvironment) {
  const entries = new Map<string, Readonly<PostgresHostConfig>>();
  const bindings: { tenantId: string; connectionRef: string; connectionDigest: string }[] = [];
  for (const connection of config.connections) {
    let ca: string | undefined;
    if (connection.tls.caFile) {
      ca = readPostgresHostFile(connection.tls.caFile, 262144);
      const certificates = ca.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
      if (!certificates?.length || ca.replace(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g, "").trim()) unavailable();
      try { for (const pem of certificates) if (!new X509Certificate(pem).ca) unavailable(); } catch { unavailable(); }
    }
    const resolved = Object.freeze({ host: connection.host, port: connection.port, database: connection.database,
      user: connection.role, password: secret(environment, connection.passwordEnv, 1), tls: Object.freeze(ca ? { ca } : {}),
      statementTimeoutMs: connection.statementTimeoutMs, lockTimeoutMs: connection.lockTimeoutMs, deadlineMs: connection.deadlineMs });
    entries.set(JSON.stringify([connection.tenantId, connection.connectionRef]), resolved);
    bindings.push({ tenantId: connection.tenantId, connectionRef: connection.connectionRef,
      connectionDigest: await postgresConnectionDigest(connection.tenantId, resolved) });
  }
  const resolve: PostgresConnectionResolver = async (tenant, ref) => {
    const found = entries.get(JSON.stringify([tenant, ref])); if (!found) unavailable(); return found;
  };
  return { resolve, bindings };
}

/** Does not initialize/migrate the ledger, provision identities or contact PostgreSQL. */
export async function startConfiguredPostgresHost(file: string, environment: SecretEnvironment) {
  const config = parsePostgresHostConfig(readPostgresHostFile(file));
  const sessionSecret = secret(environment, config.sessionSecretEnv, 32);
  const connections = await configuredPostgresConnections(config, environment);
  const store = openPostgresSqliteControl(config.controlStorePath);
  try {
    const server = await startPostgresHttpHost({ origin: config.origin, port: config.port, maxRequests: config.maxRequests,
      requestDeadlineMs: config.requestDeadlineMs, maxConcurrentExecutions: config.maxConcurrentExecutions,
      env: { AUTH_COOKIE_SECRET: sessionSecret, ODAP_GATEWAY_DB: store.db }, resolve: connections.resolve });
    let closed = false;
    return { address: server.address, bindings: connections.bindings, async close(graceMs = config.shutdownGraceMs) {
      if (closed) return { drained: true };
      const result = await server.close(graceMs);
      if (result.drained) { store.close(); closed = true; }
      return result;
    } };
  } catch { store.close(); throw new Error("PostgreSQL configured host unavailable"); }
}
