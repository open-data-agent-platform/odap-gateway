import { readFileSync, statSync } from "node:fs";
import { assessDatabaseReadCapabilities, databaseAdapterInventory } from "../lib/database-adapter-capabilities";

const args = process.argv.slice(2);
try {
  if (args.length === 1 && args[0] === "--list") {
    console.log(JSON.stringify({ schemaVersion: "adapter-inventory.v1", offlineAssessment: true,
      authorizationGranted: false, adapters: databaseAdapterInventory() }, null, 2));
  } else if (args.length === 2 && args[0] === "--request") {
    const stat = statSync(args[1]);
    if (!stat.isFile() || stat.size > 65536) throw new Error("Invalid file");
    const bytes = readFileSync(args[1]);
    if (bytes.length > 65536) throw new Error("Invalid file");
    const assessment = assessDatabaseReadCapabilities(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    console.log(JSON.stringify(assessment, null, 2));
    process.exitCode = assessment.compatible ? 0 : 2;
  } else {
    throw new Error("Invalid arguments");
  }
} catch {
  // File names and parser errors can contain caller-supplied secrets.
  console.error("Adapter inspection failed. Use --list or --request <JSON file up to 64 KiB>.");
  process.exitCode = 1;
}
