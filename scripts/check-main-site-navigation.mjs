// Run against a /gateway static build and a dry-run Worker bundle; no external I/O.
import assert from "node:assert/strict";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { Miniflare } from "miniflare";

const bundle = process.argv[2];
assert(bundle, "Provide the Wrangler dry-run bundle path");
const output = resolve(process.argv[3] || "artifacts/main-site-navigation");
mkdirSync(output, { recursive: true });
const { chromium } = createRequire(import.meta.url)(process.env.ODAP_PLAYWRIGHT_MODULE || "playwright");
const runtime = new Miniflare({ modules: true, script: readFileSync(bundle, "utf8"),
  compatibilityDate: "2026-07-01", bindings: { GATEWAY_MODE: "production", GATEWAY_BASE_PATH: "/gateway" },
  assets: { directory: resolve("out"), binding: "ASSETS", routerConfig: {
    has_user_worker: true, invoke_user_worker_ahead_of_assets: true
  } }
});
let browser;
const results = [], unexpectedRequests = [], errors = [];
try {
  browser = await chromium.launch({ executablePath: process.env.ODAP_BROWSER_EXECUTABLE, headless: true });
  for (const width of [320, 390, 768, 1024, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: "block" });
    const mainDocuments = [];
    await context.route("**/*", async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.hostname === "fonts.googleapis.com" && request.method() === "GET") {
        return route.fulfill({ contentType: "text/css", body: "" });
      }
      if (url.origin !== "https://googlesql.com" || request.method() !== "GET") {
        unexpectedRequests.push({ method: request.method(), url: request.url() });
        return route.abort();
      }
      if (url.pathname === "/") {
        assert(request.isNavigationRequest(), "Return must be a full document navigation");
        mainDocuments.push(url.href);
        return route.fulfill({ contentType: "text/html", body:
          '<title>Main site fixture</title><h1>ODAP main site</h1><a href="https://googlesql.com/gateway">Gateway</a>' });
      }
      const response = await runtime.dispatchFetch(request.url(), { redirect: "manual" });
      return route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers),
        body: Buffer.from(await response.arrayBuffer()) });
    });
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(error.message));
    for (const path of ["/gateway", "/gateway/login", "/gateway/docs", "/gateway/sql"]) {
      const response = await page.goto("https://googlesql.com" + path, { waitUntil: "networkidle" });
      assert.equal(response.status(), 200, path);
      const header = page.locator("header").getByRole("link", { name: "Back to main site", exact: true });
      const footer = page.locator("footer").getByRole("link", { name: "Back to main site", exact: true });
      for (const link of [header, footer]) {
        assert.equal(await link.getAttribute("href"), "https://googlesql.com/");
        assert.equal(await link.getAttribute("target"), null);
      }
      const box = await header.boundingBox();
      assert(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= width && box.height >= 32);
      const headerOverflow = await page.locator("header").evaluate(element => element.scrollWidth > window.innerWidth);
      assert.equal(headerOverflow, false, `Header overflow: ${width} ${path}`);
      assert((await page.locator("footer").innerText()).includes("Visit googlesql.com for the ODAP project overview and documentation."));
      await header.focus();
      assert(await header.evaluate(element => element === document.activeElement));
      if (path === "/gateway") {
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false,
          `Homepage overflow: ${width}`);
      }
      await page.screenshot({ path: resolve(output, `${path.slice(1).replaceAll("/", "-")}-${width}.png`) });
      const count = mainDocuments.length;
      await header.press("Enter");
      await page.waitForURL("https://googlesql.com/");
      await page.getByRole("heading", { name: "ODAP main site" }).waitFor();
      assert.equal(mainDocuments.length, count + 1);
      await page.getByRole("link", { name: "Gateway", exact: true }).click();
      await page.waitForURL("https://googlesql.com/gateway");
      await page.waitForLoadState("networkidle");
      await page.locator("footer").getByRole("link", { name: "Back to main site", exact: true }).click();
      await page.waitForURL("https://googlesql.com/");
      assert.equal(mainDocuments.length, count + 2);
      results.push({ width, path, headerKeyboardReturn: true, footerReturn: true, roundTrip: true });
    }
    await context.close();
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpectedRequests, []);
  writeFileSync(resolve(output, "result.json"), JSON.stringify({ passed: true, results, errors, unexpectedRequests,
    stubs: ["Google Fonts stylesheet: empty CSS", "Main site: local navigation fixture"] }, null, 2));
  console.log(JSON.stringify({ passed: true, cases: results.length }));
} catch (error) {
  writeFileSync(resolve(output, "result.json"), JSON.stringify({ passed: false, results, errors, unexpectedRequests, error: error.message }, null, 2));
  throw error;
} finally {
  await browser?.close();
  await runtime.dispose();
}
