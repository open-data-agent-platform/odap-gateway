import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { D1Database, D1PreparedStatement, D1Value } from "../../lib/d1";

const run = promisify(execFile);

export async function jobSqlite(path: string, mode: string, sql = "", params: D1Value[] = []) {
  const python = process.env.ODAP_TEST_PYTHON || (process.platform === "win32" ? "python" : "python3");
  const { stdout } = await run(python, ["tests/fixtures/job-binding-sqlite.py", path,
    mode, JSON.stringify([sql, params])]);
  return JSON.parse(stdout);
}

async function bindingQuery(path: string, mode: string, sql: string, params: D1Value[]) {
  try {
    return await jobSqlite(path, mode, sql, params);
  } catch (error) {
    // Expose SQLite's actual constraint diagnostic, not the child command's
    // echoed arguments (which can themselves contain arbitrary caller text).
    if (error instanceof Error && "stderr" in error && typeof error.stderr === "string") {
      const diagnostic = /^sqlite3\.IntegrityError: ([^\r\n]+)$/.exec(error.stderr.trimEnd().split(/\r?\n/).pop() ?? "");
      if (diagnostic) throw new Error("D1_ERROR: " + diagnostic[1] + ": SQLITE_CONSTRAINT", { cause: error });
    }
    throw error;
  }
}

export function jobDatabase(file: () => string, mode: "readwrite" | "readonly" | "readonly-after-expiry" = "readwrite") {
  const readMode = mode === "readwrite" ? "first" : mode === "readonly" ? "readonly-first" : "readonly-first-after-expiry";
  return { prepare: (sql: string) => ({ bind: (...params: D1Value[]) => ({
    run: () => mode !== "readwrite" ? Promise.reject(new Error("Read-only fixture")) : bindingQuery(file(), "run", sql, params),
    first: () => bindingQuery(file(), readMode, sql, params)
  }) }) } as D1Database;
}

export function jobTransactionalDatabase(file: () => string): D1Database {
  const base = jobDatabase(file);
  const commands = new WeakMap<D1PreparedStatement, [string, D1Value[]]>();
  const prepare = (sql: string, params: D1Value[] = []): D1PreparedStatement => {
    const statement = {
      ...base.prepare(sql).bind(...params),
      all: async () => (await bindingQuery(file(), "batch", JSON.stringify([[sql, params]]), []))[0],
      bind: (...values: D1Value[]) => prepare(sql, values)
    };
    commands.set(statement, [sql, params]);
    return statement;
  };
  return {
    prepare,
    batch: async statements => {
      const input = statements.map(statement => {
        const command = commands.get(statement);
        if (!command) throw new Error("Statement belongs to another fixture binding");
        return command;
      });
      return bindingQuery(file(), "batch", JSON.stringify(input), []);
    }
  };
}
