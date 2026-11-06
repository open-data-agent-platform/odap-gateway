import { SESSION_COOKIE, signAuthPayload } from "../../lib/auth";
import { serveCoverageStdio } from "../../scripts/coverage-stdio";
import { jobDatabase } from "./job-sqlite";

// Synthetic subprocess host for integration tests; not a deployment entrypoint.
async function main() {
  const file = process.argv[2];
  if (!file) throw new Error("Missing fixture");
  const secret = "local-stdio-fixture-only";
  const token = await signAuthPayload({ provider: "google", providerId: "pipe-owner", name: "Fixture",
    email: "fixture@example.test", expiresAt: Date.now() + 60_000 }, secret);
  let fetches = 0;
  globalThis.fetch = async () => { fetches++; throw new Error("Network disabled"); };
  await serveCoverageStdio(process.stdin, process.stdout, { DB: jobDatabase(() => file, "readonly"), AUTH_COOKIE_SECRET: secret },
    () => new Request("https://gateway.invalid", { headers: { Cookie: SESSION_COOKIE + "=" + token } }));
  if (fetches) throw new Error("Unexpected outbound request");
}
main().catch(() => { process.stderr.write("Local fixture session terminated\n"); process.exitCode = 1; });
