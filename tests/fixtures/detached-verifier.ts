import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export async function buildDetachedVerifier(dir: string, script = "verify-settled-evidence") {
  await exec(process.execPath, [require.resolve("typescript/bin/tsc"),
    "-p", "scripts/tsconfig.evidence.json", "--outDir", dir]);
  return (...args: string[]) => exec(process.execPath,
    [join(dir, `scripts/${script}.js`), ...args], { cwd: dir });
}
