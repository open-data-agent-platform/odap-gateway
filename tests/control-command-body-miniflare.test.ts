import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const bundler = createRequire(require.resolve("wrangler/package.json"))("esbuild") as typeof import("esbuild");
let mf: Miniflare;

describe("control command bodies in installed Workers", () => {
  beforeAll(async () => {
    const bundle = await bundler.build({ bundle: true, write: false, format: "esm", platform: "browser",
      stdin: { resolveDir: resolve(__dirname, ".."), contents: `
        import { readCommandBody } from "./lib/control-command-request";
        import { onRequestPost } from "./functions/api/control/[tenant]/proposals";
        import { signAuthPayload, SESSION_COOKIE } from "./lib/auth";
        export default { async fetch(incoming) {
          const mode = new URL(incoming.url).pathname.slice(1);
          const abort = new AbortController();
          let cancellations = 0, calls = 0;
          const cancel = () => { cancellations++; return new Promise(() => {}); };
          let body;
          if (mode === "stall" || mode === "route-stall") body = new ReadableStream({ cancel });
          else if (mode === "oversized") body = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(65)); }, cancel });
          else if (mode === "invalid-utf8") body = new Uint8Array([34, 255, 34]);
          else body = " ".repeat(62) + "{}";
          const secret = "synthetic-command-body-secret";
          const token = await signAuthPayload({ provider: "google", providerId: "reviewer", email: "fixture@example.test",
            name: "Fixture", expiresAt: Date.now() + 60000 }, secret);
          if (mode === "aborted") abort.abort();
          const request = new Request("https://gateway.test/api/control/t/proposals", {
            method: "POST", body, signal: abort.signal, headers: { Origin: "https://gateway.test",
              "Content-Type": "application/json", Cookie: SESSION_COOKIE + "=" + token }
          });
          // Only the membership read is permitted; reaching any command storage is a failure.
          const db = { prepare(query) { calls++;
            if (calls !== 1 || !query.startsWith("SELECT role FROM control_memberships")) throw new Error("Unexpected command storage");
            return { bind() { return { first: async () => ({ role: "reviewer" }) }; } };
          }};
          const result = mode.startsWith("route-")
            ? await onRequestPost({ request, env: { DB: db, AUTH_COOKIE_SECRET: secret }, params: { tenant: "t" } })
            : await readCommandBody(request, 64, "proposal");
          if (!(result instanceof Response)) return Response.json({ data: result.data, locked: request.body.locked });
          return Response.json({ status: result.status, body: await result.json(), cancellations,
            locked: request.body.locked, calls });
        }}
      ` }
    });
    const config = JSON.parse(readFileSync(resolve(__dirname, "../wrangler.example.jsonc"), "utf8"));
    mf = new Miniflare({ host: "127.0.0.1", port: 0, modules: true, script: bundle.outputFiles[0].text,
      compatibilityDate: config.compatibility_date, outboundService: () => { throw new Error("Unexpected network call"); } });
  }, 30000);
  afterAll(async () => { await mf?.dispose(); });
  const run = async (mode: string) => (await mf.dispatchFetch("http://localhost/" + mode)).json();

  it("accepts the exact byte ceiling and releases the native reader", async () => {
    expect(await run("valid")).toEqual({ data: {}, locked: false });
  });

  it("refuses excessive bytes without awaiting a stalled cancellation", async () => {
    expect(await run("oversized")).toEqual({ status: 413, body: { ok: false, code: "proposal_too_large" },
      cancellations: 1, locked: false, calls: 0 });
  });

  it.each(["invalid-utf8", "aborted"])("sanitizes %s", async mode => {
    expect(await run(mode)).toMatchObject({ status: 400, body: { ok: false, code: "invalid_proposal" }, locked: false, calls: 0 });
  });

  it.each(["stall", "route-stall"])("bounds a native %s stream and does not reach command storage", async mode => {
    const start = Date.now();
    expect(await run(mode)).toEqual({ status: 408, body: { ok: false, code: "proposal_timeout" },
      cancellations: 1, locked: false, calls: mode === "route-stall" ? 1 : 0 });
    expect(Date.now() - start).toBeGreaterThanOrEqual(14_000);
    expect(Date.now() - start).toBeLessThan(25_000);
  }, 30000);
});
