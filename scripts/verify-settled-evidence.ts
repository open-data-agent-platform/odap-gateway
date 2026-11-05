import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { verifySettledEvidence } from "../lib/settled-evidence";

const usage = "Usage: verify-settled-evidence <bundle.json> <tenant> <intent> <expected.sha256>";

async function readText(path: string, limit: number) {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error("Invalid input file");
    const bytes = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await file.read(bytes, size, bytes.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size !== stat.size) throw new Error("Input size changed");
    // Preserve any BOM and reject invalid bytes rather than hashing repaired text.
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, size));
  } finally { await file.close(); }
}

async function main(args: string[]) {
  if (args.length === 1 && args[0] === "--help") {
    console.log(usage);
    return;
  }
  if (args.length !== 4 || args.some(v => !v.trim())) {
    console.error(usage);
    process.exitCode = 2;
    return;
  }
  const [bundle, tenantId, intentId, pinFile] = args;
  const pin = await readText(pinFile, 128);
  if (!/^sha256:[0-9a-f]{64}(?:\r?\n)?$/.test(pin)) throw new Error("Invalid pin");
  const json = await readText(bundle, 4 * 1024 * 1024);
  const report = await verifySettledEvidence(json, { tenantId, intentId }, pin.trimEnd());
  console.log(JSON.stringify(report));
}

main(process.argv.slice(2)).catch((error: unknown) => {
  // File and parser errors can contain private paths or excerpts from evidence.
  const message = error instanceof Error && ["Invalid pin", "Evidence checksum mismatch", "Evidence scope mismatch"].includes(error.message)
    ? error.message : "Unreadable or invalid evidence input";
  console.error(message);
  process.exitCode = 1;
});
