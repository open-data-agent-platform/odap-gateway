import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
const { DatabaseSync } = process.getBuiltinModule("node:sqlite");

// Synthetic fixture only. Production opening never initializes or migrates a file.
export function initializePostgresLocalFixture(path: string) {
  const native = new DatabaseSync(path);
  try {
    native.exec("BEGIN IMMEDIATE");
    for (const name of readdirSync("db/migrations").filter(name => name.endsWith(".sql")).sort()) {
      native.exec(readFileSync(join("db/migrations", name), "utf8").replaceAll("\r\n", "\n"));
    }
    native.exec("COMMIT");
  } finally { native.close(); }
}
