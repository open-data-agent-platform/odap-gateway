import { exportOpenLineage } from "../lib/openlineage-export";
import { settledEvidenceMaxBytes } from "../lib/settled-evidence";
import { readEvidenceText } from "./evidence-input";

const usage = "Usage: export-openlineage <bundle.json> <tenant> <intent> <expected.sha256> <deployment-namespace> [--audience <expected-audience>]";

async function main(args: string[]) {
  if (args.length === 1 && args[0] === "--help") { console.log(usage); return; }
  if (!(args.length === 5 || (args.length === 7 && args[5] === "--audience")) || args.some(v => !v.trim())) {
    console.error(usage);
    process.exitCode = 2;
    return;
  }
  const [file, tenantId, intentId, pinFile, namespace, , audience] = args;
  const pin = await readEvidenceText(pinFile, 128);
  if (!/^sha256:[0-9a-f]{64}(?:\r?\n)?$/.test(pin)) throw new Error("Invalid pin");
  const json = await readEvidenceText(file, settledEvidenceMaxBytes);
  const events = await exportOpenLineage(json, { tenantId, intentId, audience }, pin.trimEnd(), namespace);
  process.stdout.write(events.map(event => JSON.stringify(event)).join("\n") + "\n");
}

main(process.argv.slice(2)).catch((error: unknown) => {
  // Never expose file paths, parser excerpts or evidence fields through errors.
  const message = error instanceof Error && ["Invalid pin", "Evidence checksum mismatch", "Evidence scope mismatch",
    "Invalid OpenLineage namespace"].includes(error.message) ? error.message : "Unreadable or invalid evidence input";
  console.error(message);
  process.exitCode = 1;
});
