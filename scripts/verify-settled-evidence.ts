import { verifySettledEvidence } from "../lib/settled-evidence";
import { readEvidenceText as readText } from "./evidence-input";

const usage = "Usage: verify-settled-evidence <bundle.json> <tenant> <intent> <expected.sha256> [--audience <expected-audience>]";

async function main(args: string[]) {
  if (args.length === 1 && args[0] === "--help") {
    console.log(usage);
    return;
  }
  if (!(args.length === 4 || (args.length === 6 && args[4] === "--audience")) || args.some(v => !v.trim())) {
    console.error(usage);
    process.exitCode = 2;
    return;
  }
  const [bundle, tenantId, intentId, pinFile, , audience] = args;
  const pin = await readText(pinFile, 128);
  if (!/^sha256:[0-9a-f]{64}(?:\r?\n)?$/.test(pin)) throw new Error("Invalid pin");
  const json = await readText(bundle, 4 * 1024 * 1024);
  const report = await verifySettledEvidence(json, { tenantId, intentId, audience }, pin.trimEnd());
  console.log(JSON.stringify(report));
}

main(process.argv.slice(2)).catch((error: unknown) => {
  // File and parser errors can contain private paths or excerpts from evidence.
  const message = error instanceof Error && ["Invalid pin", "Evidence checksum mismatch", "Evidence scope mismatch"].includes(error.message)
    ? error.message : "Unreadable or invalid evidence input";
  console.error(message);
  process.exitCode = 1;
});
