import { parseTree, getNodeValue, type Node, type ParseError } from "jsonc-parser";
import { isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { postgresIdentifier } from "../../lib/postgresql-metric-compiler";

export type PostgresHostFile = Readonly<{
  schemaVersion: 1; origin: string; port: number; controlStorePath: string;
  sessionSecretEnv: string; maxRequests: number; maxConcurrentExecutions: number;
  requestDeadlineMs: number; shutdownGraceMs: number;
  connections: readonly Readonly<{
    tenantId: string; connectionRef: string; host: string; port: number;
    database: string; role: string; passwordEnv: string; tls: Readonly<{ caFile?: string }>;
    statementTimeoutMs: number; lockTimeoutMs: number; deadlineMs: number;
  }>[];
}>;
export class PostgresHostConfigurationError extends Error {
  constructor() { super("PostgreSQL host configuration unavailable"); }
}
function fail(): never { throw new PostgresHostConfigurationError(); }
const exact = (value: unknown, fields: string[]): value is Record<string, unknown> => !!value &&
  typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key));
const integer = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
const id = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const secretRef = (value: unknown): value is string => typeof value === "string" && /^ODAP_[A-Z][A-Z0-9_]{1,100}$/.test(value);
const path = (value: unknown): value is string => typeof value === "string" && value.length <= 4096 &&
  isAbsolute(value) && !/[\u0000-\u001f\u007f]/.test(value);

/** Read only a bounded, existing regular file; never create it or read credentials. */
export function readPostgresHostFile(file: string, maximum = 65536): string {
  let fd: number | undefined;
  try {
    if (!path(file) || !integer(maximum, 1, 1048576)) fail();
    const before = lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.size < 1 || before.size > maximum) fail();
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd);
    if (!opened.isFile() || before.dev !== opened.dev || before.ino !== opened.ino || opened.size > maximum) fail();
    const bytes = Buffer.alloc(maximum + 1); let count = 0;
    while (count < bytes.length) {
      const n = readSync(fd, bytes, count, bytes.length - count, null); if (!n) break; count += n;
    }
    const after = fstatSync(fd);
    if (!count || count > maximum || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || count !== opened.size) fail();
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, count));
  } catch { return fail(); }
  finally { if (fd !== undefined) closeSync(fd); }
}

/** Pure validation. No secret/environment, ledger or provider access. */
export function parsePostgresHostConfig(text: string): PostgresHostFile {
  try {
    if (typeof text !== "string" || !text || Buffer.byteLength(text) > 65536) fail();
    const errors: ParseError[] = [];
    const tree = parseTree(text, errors, { allowTrailingComma: false, disallowComments: true });
    if (!tree || errors.length) fail();
    const walk = (node: Node, depth: number) => {
      if (depth > 8) fail();
      if (node.type === "object") {
        const keys = node.children?.map(child => child.children?.[0]?.value) ?? [];
        if (keys.some(key => typeof key !== "string") || new Set(keys).size !== keys.length) fail();
      }
      for (const child of node.children ?? []) walk(child, depth + 1);
    };
    walk(tree, 0);
    const value: unknown = getNodeValue(tree);
    if (!exact(value, ["schemaVersion", "origin", "port", "controlStorePath", "sessionSecretEnv", "maxRequests",
      "maxConcurrentExecutions", "requestDeadlineMs", "shutdownGraceMs", "connections"]) || value.schemaVersion !== 1 ||
      typeof value.origin !== "string" || !path(value.controlStorePath) || !secretRef(value.sessionSecretEnv) ||
      !integer(value.port, 1, 65535) || !integer(value.maxRequests, 1, 1024) ||
      !integer(value.maxConcurrentExecutions, 1, 1000) || value.maxConcurrentExecutions > value.maxRequests ||
      !integer(value.requestDeadlineMs, 100, 120000) || !integer(value.shutdownGraceMs, 0, 120000) ||
      !Array.isArray(value.connections) || !value.connections.length || value.connections.length > 64) fail();
    const origin = new URL(value.origin);
    if (origin.protocol !== "https:" || origin.origin !== value.origin) fail();
    const seen = new Set<string>();
    for (const connection of value.connections) {
      if (!exact(connection, ["tenantId", "connectionRef", "host", "port", "database", "role", "passwordEnv", "tls",
        "statementTimeoutMs", "lockTimeoutMs", "deadlineMs"]) || !id(connection.tenantId) || !id(connection.connectionRef) ||
        typeof connection.host !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/.test(connection.host) ||
        !integer(connection.port, 1, 65535) || typeof connection.database !== "string" || typeof connection.role !== "string" ||
        !secretRef(connection.passwordEnv) || connection.passwordEnv === value.sessionSecretEnv ||
        !(exact(connection.tls, []) || (exact(connection.tls, ["caFile"]) && path(connection.tls.caFile))) ||
        !integer(connection.statementTimeoutMs, 1, 30000) || !integer(connection.lockTimeoutMs, 1, connection.statementTimeoutMs) ||
        !integer(connection.deadlineMs, connection.statementTimeoutMs + 1, 60000) || connection.deadlineMs > value.requestDeadlineMs) fail();
      postgresIdentifier(connection.database); postgresIdentifier(connection.role);
      const key = JSON.stringify([connection.tenantId, connection.connectionRef]);
      if (seen.has(key)) fail(); seen.add(key);
      Object.freeze(connection.tls); Object.freeze(connection);
    }
    Object.freeze(value.connections);
    return Object.freeze(value) as PostgresHostFile;
  } catch { return fail(); }
}

export function postgresHostConfigSummary(config: PostgresHostFile) {
  return { schemaVersion: 1, connections: config.connections.length,
    configDigest: "sha256:" + createHash("sha256").update(JSON.stringify(config)).digest("hex"),
    providerContacted: false, credentialsRead: false, controlStoreOpened: false };
}
