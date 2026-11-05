import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { D1Value } from "../../lib/d1";

const run = promisify(execFile);

export async function jobSqlite(path: string, mode: string, sql = "", params: D1Value[] = []) {
  const python = process.env.ODAP_TEST_PYTHON || (process.platform === "win32" ? "python" : "python3");
  const { stdout } = await run(python, ["tests/fixtures/job-binding-sqlite.py", path,
    mode, JSON.stringify([sql, params])]);
  return JSON.parse(stdout);
}
