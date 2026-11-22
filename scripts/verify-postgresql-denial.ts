import { postgresDenialEvidenceMaxBytes, verifyPostgresDenialEvidence } from "../lib/postgresql-denial-evidence";
import { readEvidenceText } from "./evidence-input";

const usage = "Usage: verify-postgresql-denial <bundle.json> <tenant> <attempt> <expected.sha256>";
async function main(args: string[]) {
  if (args.length === 1 && args[0] === "--help") { console.log(usage); return; }
  if (args.length !== 4 || args.some(value => !value.trim())) { console.error(usage); process.exitCode = 2; return; }
  const [file, tenantId, attemptId, pinFile] = args;
  const pin = (await readEvidenceText(pinFile, 128)).replace(/\r?\n$/, "");
  if (!/^sha256:[a-f0-9]{64}$/.test(pin)) throw new Error("Invalid pin");
  const json = await readEvidenceText(file, postgresDenialEvidenceMaxBytes);
  console.log(JSON.stringify(await verifyPostgresDenialEvidence(json, { tenantId, attemptId }, pin)));
}
main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error && ["Invalid pin", "Evidence checksum mismatch", "Evidence scope mismatch"].includes(error.message)
    ? error.message : "Unreadable or invalid evidence input");
  process.exitCode = 1;
});
