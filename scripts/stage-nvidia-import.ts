import { constants } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { NVIDIA_IMPORT_LIMIT, prepareNvidiaSemanticImport } from "../lib/nvidia-semantic-import";

const usage = "Usage: stage-nvidia-import <sql-attribute-response.json> <mapping.json> <new-bundle.json>";

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
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, size));
  } finally { await file.close(); }
}

async function main(args: string[]) {
  if (args.length === 1 && args[0] === "--help") { console.log(usage); return; }
  if (args.length !== 3 || args.some(arg => !arg.trim())) { console.error(usage); process.exitCode = 2; return; }
  const [source, mapping, output] = args;
  const bundle = await prepareNvidiaSemanticImport(await readText(source, NVIDIA_IMPORT_LIMIT), await readText(mapping, 48 * 1024));
  const file = await open(output, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(bundle, null, 2) + "\n", "utf8");
  } catch (error) {
    await file.close();
    await unlink(output);
    throw error;
  }
  await file.close();
  console.log(JSON.stringify({ status: "staged-only", evidenceDigest: bundle.evidenceDigest }));
}

main(process.argv.slice(2)).catch(() => {
  // Never echo SQL, input fragments, private paths or provider metadata on failure.
  console.error("Unable to stage import: invalid input or output unavailable");
  process.exitCode = 1;
});
