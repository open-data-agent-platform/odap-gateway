import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const bundler = createRequire(require.resolve("wrangler/package.json"))("esbuild") as typeof import("esbuild");
let mf: Miniflare;

describe("parsed schema policy in installed Workers", () => {
  beforeAll(async () => {
    const bundle = await bundler.build({ bundle: true, write: false, format: "esm", platform: "browser",
      stdin: { resolveDir: resolve(__dirname, ".."), contents: `
        import worker from "./worker";
        import { signAuthPayload, SESSION_COOKIE } from "./lib/auth";
        export default { async fetch(incoming) {
          const secret = "synthetic-parser-cookie-secret";
          const token = await signAuthPayload({ provider: "google", providerId: "fixture", email: "fixture@example.test",
            name: "Fixture", expiresAt: Date.now() + 60000 }, secret);
          const request = new Request("https://gateway.test/gateway/api/query/dry-run", {
            method: "POST", body: await incoming.text(), headers: { "Content-Type": "application/json",
              Cookie: SESSION_COOKIE + "=" + token }
          });
          const live = new URL(incoming.url).pathname === "/blocked";
          return worker.fetch(request, { GATEWAY_MODE: "demo", GATEWAY_BASE_PATH: "/gateway", AUTH_COOKIE_SECRET: secret,
            ...(live ? { BIGQUERY_PROJECT_ID: "fixture-project", BIGQUERY_CLIENT_EMAIL: "fixture@example.test",
              BIGQUERY_PRIVATE_KEY: "synthetic-unused" } : {}),
            ASSETS: { fetch() { throw new Error("Unexpected assets"); } }
          }, { waitUntil() {} });
        }}
      ` } });
    const config = JSON.parse(readFileSync(resolve(__dirname, "../wrangler.example.jsonc"), "utf8"));
    mf = new Miniflare({ host: "127.0.0.1", port: 0, modules: true, script: bundle.outputFiles[0].text,
      compatibilityDate: config.compatibility_date, outboundService: () => { throw new Error("Unexpected network call"); } });
  }, 30000);
  afterAll(async () => { await mf?.dispose(); });

  it.each([
    "SELECT `customer_id` FROM `demo.orders`", "SELECT customer_id AS customer_id FROM demo.orders",
    "SELECT order_id FROM demo.orders WHERE `customer_id` = 1",
    "SELECT COUNT(*) FROM `demo.orders`, `private.secrets`", "SELECT o.* EXCEPT(order_id) FROM demo.orders o",
    "WITH x AS (SELECT customer_id FROM demo.orders) SELECT * FROM x",
    "SELECT order_id FROM demo.orders UNION ALL SELECT customer_id FROM demo.orders",
    "SELECT order_id AS customer_id FROM demo.orders GROUP BY order_id HAVING COUNT(customer_id) > 0"
  ])("refuses policy violations before the demo live transport: %s", async sql => {
    const response = await mf.dispatchFetch("http://localhost/blocked", { method: "POST", body: JSON.stringify({ sql, workspace: "demo" }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ persisted: false, preview: { status: "blocked", scannedBytes: 0,
      error: { code: "schema_policy_blocked" } } });
  });

  it.each([
    "SELECT `order_id` FROM demo.orders WHERE order_date >= CURRENT_DATE()",
    "SELECT COUNT(*) AS n FROM demo.orders WHERE order_date >= CURRENT_DATE()",
    "SELECT EXTRACT(ISOWEEK FROM order_date) AS week FROM demo.orders WHERE order_date >= CURRENT_DATE()"
  ])("retains safe simulated previews: %s", async sql => {
    const response = await mf.dispatchFetch("http://localhost/simulated", { method: "POST", body: JSON.stringify({ sql, workspace: "demo" }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ persisted: false, preview: { mode: "simulated", configured: false,
      error: { code: "bigquery_not_configured" } } });
  });
});
