import { Client } from "pg";
import { compilePostgresMetric, postgresIdentifier, type PostgresSource } from "../../lib/postgresql-metric-compiler";
import { submitPreparedRead } from "../../lib/read-submission";
import type { SemanticRelease } from "../../lib/control-objects";
import { acknowledgePostgresFailure } from "./terminal";
import type { PostgresFailureCode } from "../../lib/postgresql-terminal";

export type PostgresHostConfig = Readonly<{
  host: string; port: number; database: string; user: string; password: string;
  tls: { ca?: string } | { insecureLoopback: true };
  statementTimeoutMs: number; lockTimeoutMs: number; deadlineMs: number;
}>;
export type PostgresRead = Readonly<{
  release: SemanticRelease; definitionJson: string; canonicalAction: string; source: PostgresSource;
}>;
export type PostgresClaim = Readonly<{
  database: string; role: string; actionDigest: string; definitionDigest: string; statementDigest: string;
}>;
export type PostgresReadResult =
  | { outcome: "succeeded"; claim: "confirmed"; value: string | null; serverVersion: "17.12"; statementDigest: string }
  | { outcome: "failed"; claim: "confirmed"; sqlState: PostgresFailureCode; statementDigest: string }
  | { outcome: "not-submitted" | "observation-required"; claim: "not-attempted" | "denied" | "unknown" | "confirmed";
      reason: "preflight-rejected" | "claim-unconfirmed" | "execution-unconfirmed" };

const typeOids = { STRING: [25], BOOL: [16], INT64: [20], DECIMAL: [1700] };

function validateConfig(c: PostgresHostConfig) {
  if (!c || typeof c.host !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/.test(c.host) ||
      !Number.isInteger(c.port) || c.port < 1 || c.port > 65535 || typeof c.password !== "string" || !c.password ||
      !c.tls || !Number.isSafeInteger(c.statementTimeoutMs) || c.statementTimeoutMs < 1 || c.statementTimeoutMs > 30000 ||
      !Number.isSafeInteger(c.lockTimeoutMs) || c.lockTimeoutMs < 1 || c.lockTimeoutMs > c.statementTimeoutMs ||
      !Number.isSafeInteger(c.deadlineMs) || c.deadlineMs <= c.statementTimeoutMs || c.deadlineMs > 60000) {
    throw new Error("Invalid PostgreSQL host configuration");
  }
  postgresIdentifier(c.database); postgresIdentifier(c.user);
  if ("insecureLoopback" in c.tls && (c.tls.insecureLoopback !== true || c.host !== "127.0.0.1")) {
    throw new Error("Unencrypted PostgreSQL is restricted to explicit loopback fixtures");
  }
}

// Trusted host API only. The claim must atomically authorize/persist this exact read.
// There is no HTTP/Agent entry point and no fallback to environment credentials.
export async function executePostgresMetric(config: PostgresHostConfig, read: PostgresRead,
  claim: (binding: PostgresClaim) => Promise<boolean>, signal?: AbortSignal): Promise<PostgresReadResult> {
  let client: Client | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false, sent = false;
  let claimState: "not-attempted" | "denied" | "unknown" | "confirmed" = "not-attempted";
  const stop = () => { stopped = true; void client?.end().catch(() => undefined); };
  try {
    validateConfig(config);
    const c = { ...config, tls: { ...config.tls } }, source = { ...read.source };
    if (c.database !== source.database || typeof claim !== "function" || signal?.aborted) throw new Error("Invalid host binding");
    const compiled = await compilePostgresMetric(read.release, read.definitionJson, read.canonicalAction, source);
    client = new Client({ host: c.host, port: c.port, database: c.database, user: c.user, password: c.password,
      ssl: "insecureLoopback" in c.tls ? false : { rejectUnauthorized: true, ...(c.tls.ca ? { ca: c.tls.ca } : {}) },
      application_name: "odap-postgresql-preview", options: "-c search_path=pg_catalog",
      connectionTimeoutMillis: Math.min(5000, c.deadlineMs),
      statement_timeout: c.statementTimeoutMs, lock_timeout: c.lockTimeoutMs,
      idle_in_transaction_session_timeout: c.deadlineMs });
    const db = client;
    db.on("error", stop);
    signal?.addEventListener("abort", stop, { once: true });
    timer = setTimeout(stop, c.deadlineMs);
    if (signal?.aborted) stop();
    const binding = Object.freeze({ database: c.database, role: c.user, actionDigest: compiled.actionDigest,
      definitionDigest: compiled.definitionDigest, statementDigest: compiled.statementDigest });
    return await submitPreparedRead(async () => {
      if (stopped) throw new Error("Read stopped");
      await db.connect();
      await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await db.query("SET LOCAL search_path = pg_catalog");
      await db.query("SET LOCAL row_security = on");
      await db.query("LOCK TABLE ONLY " + compiled.relation + " IN ACCESS SHARE MODE");
      const info = await db.query(`SELECT current_database() AS database, current_user AS role,
        current_setting('server_version_num') AS version, current_setting('transaction_read_only') AS readonly,
        r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication AS privileged,
        c.relkind, c.relispartition, pg_has_role(current_user, c.relowner, 'MEMBER') AS owner,
        row_security_active(c.oid) AS rls, has_table_privilege(c.oid, 'SELECT') AS readable,
        has_table_privilege(c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR
          has_any_column_privilege(c.oid, 'INSERT,UPDATE,REFERENCES') AS writable,
        EXISTS(SELECT 1 FROM pg_inherits WHERE inhparent = c.oid OR inhrelid = c.oid) AS inherited
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_roles r ON r.rolname = current_user WHERE n.nspname = $1 AND c.relname = $2`, [source.schema, source.table]);
      const m = info.rows[0];
      if (info.rows.length !== 1 || m.database !== c.database || m.role !== c.user || m.version !== "170012" ||
          m.readonly !== "on" || m.privileged !== false || m.relkind !== "r" || m.relispartition !== false ||
          m.owner !== false || m.rls !== true || m.readable !== true || m.writable !== false || m.inherited !== false) {
        throw new Error("Unsupported PostgreSQL security or relation configuration");
      }
      const metadata = await db.query(`SELECT a.attname AS name, a.atttypid AS oid
        FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped`, [source.schema, source.table]);
      for (const column of compiled.columns) {
        const actual = metadata.rows.find(r => r.name === column.name);
        if (!actual || !typeOids[column.type].includes(actual.oid)) throw new Error("Unsupported PostgreSQL column type");
      }
      return async () => {
        if (stopped) throw new Error("Read stopped");
        sent = true;
        const result = await db.query({ text: compiled.text, values: [...compiled.values], rowMode: "array",
          types: { getTypeParser: () => (value: string) => value } }).catch(async error => {
          const failure = await acknowledgePostgresFailure(error, () => db.query("ROLLBACK"), () => stopped);
          if (!failure) throw error;
          return failure;
        });
        if ("outcome" in result) return { ...result, statementDigest: compiled.statementDigest };
        const value: unknown = result.rows[0]?.[0];
        if (result.rows.length !== 1 || result.fields.length !== 1 || result.fields[0].name !== "metric_value" ||
            ![20, 1700].includes(result.fields[0].dataTypeID) || !(value === null || (typeof value === "string" &&
              value.length <= 256 && /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value)))) throw new Error("Unsupported PostgreSQL result");
        await db.query("ROLLBACK");
        if (stopped) throw new Error("Read acknowledgement unavailable");
        return { outcome: "succeeded" as const, claim: "confirmed" as const, value,
          serverVersion: "17.12" as const, statementDigest: compiled.statementDigest };
      };
    }, async () => {
      if (stopped) return false;
      claimState = "unknown";
      const accepted = await claim(binding);
      claimState = accepted === true ? "confirmed" : "denied";
      return accepted === true;
    });
  } catch {
    return { outcome: sent ? "observation-required" : "not-submitted", claim: claimState,
      reason: sent ? "execution-unconfirmed" : claimState === "not-attempted" ? "preflight-rejected" : "claim-unconfirmed" };
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
    await client?.end().catch(() => undefined);
  }
}
