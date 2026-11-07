import { auxiliaryCostMaxBytes, verifyAuxiliaryCostEvidence } from "../lib/auxiliary-cost-evidence";
import { readEvidenceText } from "./evidence-input";

const usage = "Usage: verify-auxiliary-cost-evidence <bundle.json> <tenant> <intent> <expected.sha256>";
async function main(args: string[]) {
  if (args.length === 1 && args[0] === "--help") { console.log(usage); return; }
  if (args.length !== 4 || args.some(value => !value.trim())) {
    console.error(usage); process.exitCode = 2; return;
  }
  const [bundle, tenantId, intentId, pinFile] = args;
  const pin = await readEvidenceText(pinFile,128);
  const expectedDigest = pin.replace(/\r?\n$/, "");
  if (expectedDigest.length !== 71 || !/^sha256:[0-9a-f]{64}$/.test(expectedDigest)) throw new Error("Invalid pin");
  const json = await readEvidenceText(bundle,auxiliaryCostMaxBytes);
  console.log(JSON.stringify(await verifyAuxiliaryCostEvidence(json,{tenantId,intentId},expectedDigest)));
}
main(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error && ["Invalid pin","Evidence checksum mismatch","Evidence scope mismatch"].includes(error.message)
    ? error.message : "Unreadable or invalid evidence input";
  console.error(message); process.exitCode = 1;
});
