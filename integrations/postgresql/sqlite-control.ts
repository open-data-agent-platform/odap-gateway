import type { DatabaseSync as Database } from "node:sqlite";
import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { D1Database, D1PreparedStatement, D1Result, D1Value } from "../../lib/d1";

// Canonical SQLite schema produced by repository migrations 0001-0039, without
// seeded identities or business data. Tests rebuild it from the migration files.
export const POSTGRES_CONTROL_SCHEMA_DIGEST = "sha256:0b619162afc44374daa3a9fbfbea7850ecea2ad0057e066b16424f1c352bfe94";
const { DatabaseSync, constants } = process.getBuiltinModule("node:sqlite");
type NativeStatement = ReturnType<Database["prepare"]> & { close(): void };
type NativeDatabase = Database & { setAuthorizer(callback: (action: number, name: string | null, argument: string | null) => number): void };
type Bound = string | number | null | Uint8Array;
type Command = { sql: string; values: Bound[] };
const codes = constants as unknown as Record<string, number>;

export class PostgresControlStoreError extends Error {
  constructor() { super("PostgreSQL local control store operation unavailable"); }
}

function bindValue(value: D1Value): Bound {
  if (value === null) return null;
  if (typeof value === "boolean") return Number(value);
  if (typeof value === "number" && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value))) return value;
  if (typeof value === "string" && Buffer.byteLength(value, "utf8") <= 1048576) return value;
  if (value instanceof ArrayBuffer && value.byteLength <= 1048576) return new Uint8Array(value.slice(0));
  throw new PostgresControlStoreError();
}

/** Trusted Node host control ledger, not a business SQLite query adapter.
 * Opens only an existing, initialized local file; never migrates or seeds it.
 * Keep its parent directory private and share this binding within one host.
 */
export function openPostgresSqliteControl(path: string): { db: D1Database; close(): void } {
  let native: NativeDatabase | undefined;
  let closed = false, internalTransaction = false;
  const fail = () => { throw new PostgresControlStoreError(); };
  const close = () => {
    if (closed) return;
    closed = true;
    native?.close();
  };
  try {
    if (process.versions.node !== "24.22.1" || typeof path !== "string" || !isAbsolute(path)) fail();
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) fail();
    const options = { enableForeignKeyConstraints: true, enableDoubleQuotedStringLiterals: false,
      allowExtension: false, defensive: true, timeout: 250 };
    native = new DatabaseSync(realpathSync(path), options) as NativeDatabase;
    const schema = native.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type,name") as NativeStatement;
    let rows;
    try { rows = schema.all().map(row => ({ ...row, sql: typeof row.sql === "string" ? row.sql.replaceAll("\r\n", "\n") : row.sql })); }
    finally { schema.close(); }
    if ("sha256:" + createHash("sha256").update(JSON.stringify(rows)).digest("hex") !== POSTGRES_CONTROL_SCHEMA_DIGEST) fail();
    native.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;");
    const check = native.prepare("SELECT (SELECT journal_mode FROM pragma_journal_mode) AS journal,(SELECT synchronous FROM pragma_synchronous) AS sync,(SELECT foreign_keys FROM pragma_foreign_keys) AS fk") as NativeStatement;
    try {
      const value = check.get();
      if (value?.journal !== "wal" || value.sync !== 2 || value.fk !== 1) fail();
    } finally { check.close(); }
    const names = ["SQLITE_TRANSACTION", "SQLITE_SAVEPOINT", "SQLITE_ATTACH", "SQLITE_DETACH", "SQLITE_PRAGMA", "SQLITE_OK", "SQLITE_DENY"];
    if (typeof native.setAuthorizer !== "function" || names.some(name => !Number.isInteger(codes[name]))) fail();
    const forbidden = new Set(names.slice(0, 5).map(name => codes[name]));
    native.setAuthorizer((action, name, argument) => {
      if (action === codes.SQLITE_PRAGMA && name === "foreign_key_check" && argument === null) return codes.SQLITE_OK;
      return forbidden.has(action) && !internalTransaction ? codes.SQLITE_DENY : codes.SQLITE_OK;
    });
  } catch {
    try { close(); } catch { /* Refuse an unusable connection without exposing its path or SQL. */ }
    throw new PostgresControlStoreError();
  }
  const connection = native;
  const transaction = (sql: "BEGIN IMMEDIATE" | "COMMIT" | "ROLLBACK") => {
    internalTransaction = true;
    try { connection.exec(sql); }
    finally { internalTransaction = false; }
  };
  const execute = (command: Command, budget: { bytes: number; rows: number }): D1Result => {
    const statement = connection.prepare(command.sql) as NativeStatement;
    try {
      // SQLite's own parser identifies the statement, including trigger bodies
      // and quoted semicolons. Reject silently ignored trailing statements.
      if (statement.sourceSQL.trim() !== command.sql.trim()) fail();
      const results: Record<string, D1Value>[] = [];
      for (const row of statement.iterate(...command.values)) {
        const result: Record<string, D1Value> = Object.create(null);
        for (const [key, value] of Object.entries(row)) {
          if (value instanceof Uint8Array) {
            budget.bytes += value.byteLength; result[key] = new Uint8Array(value).buffer;
          } else {
            if (typeof value === "bigint" || (typeof value === "number" && !Number.isFinite(value))) fail();
            budget.bytes += typeof value === "string" ? Buffer.byteLength(value, "utf8") : 8;
            result[key] = value as D1Value;
          }
          budget.bytes += Buffer.byteLength(key, "utf8");
        }
        if (++budget.bytes > 8388608 || ++budget.rows > 10000) fail();
        results.push(result);
      }
      const changed = connection.prepare("SELECT changes() AS n") as NativeStatement;
      try { return { success: true, results, meta: { changes: changed.get()?.n } }; }
      finally { changed.close(); }
    } finally { statement.close(); }
  };
  const atomic = (commands: Command[], validate?: (results: D1Result[]) => void) => {
    if (closed || connection.isTransaction || commands.length < 1 || commands.length > 100) fail();
    try {
      transaction("BEGIN IMMEDIATE");
      const budget = { bytes: 0, rows: 0 };
      const results = commands.map(command => execute(command, budget));
      validate?.(results);
      transaction("COMMIT");
      return results;
    } catch {
      if (connection.isTransaction) {
        try { transaction("ROLLBACK"); }
        catch { try { close(); } catch { /* The binding remains closed on failed cleanup. */ } }
      }
      throw new PostgresControlStoreError();
    }
  };
  const owned = new WeakMap<D1PreparedStatement, Command>();
  const prepare = (sql: string, values: Bound[] = []): D1PreparedStatement => {
    if (closed || typeof sql !== "string" || !sql.trim() || sql.length > 65536 || sql.includes("\0")) fail();
    const command = { sql, values };
    const statement: D1PreparedStatement = {
      bind: (...input) => prepare(sql, input.map(bindValue)),
      all: async <T>() => atomic([command])[0] as D1Result<T>,
      run: async <T>() => atomic([command])[0] as D1Result<T>,
      first: async <T>(column?: string) => {
        const row = atomic([command], results => {
          const first = results[0].results?.[0];
          if (first && column !== undefined && !Object.hasOwn(first, column)) fail();
        })[0].results?.[0];
        if (!row) return null;
        return (column === undefined ? row : row[column]) as T;
      },
    };
    owned.set(statement, command);
    return statement;
  };
  const db: D1Database = { prepare, batch: async statements => {
    if (!Array.isArray(statements)) fail();
    const commands = statements.map(statement => { const command = owned.get(statement); if (!command) fail(); return command; });
    return atomic(commands as Command[]);
  } };
  return { db, close };
}
