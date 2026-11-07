// Verify the mounted production export locally; no external I/O or identity.
import assert from "node:assert/strict";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { Miniflare } from "miniflare";

const bundle = process.argv[2];
assert(bundle, "Provide the Wrangler dry-run bundle path");
const output = resolve(process.argv[3] || "artifacts/preview-docs");
mkdirSync(output, { recursive: true });
const { chromium } = createRequire(import.meta.url)(process.env.ODAP_PLAYWRIGHT_MODULE || "playwright");
const unexpected = [], errors = [], failures = [], results = [];
const runtime = new Miniflare({ modules: true, script: readFileSync(bundle, "utf8"),
  compatibilityDate: "2026-07-01", bindings: { GATEWAY_MODE: "production", GATEWAY_BASE_PATH: "/gateway" },
  outboundService() { throw new Error("Unexpected external request"); },
  assets: { directory: resolve("out"), binding: "ASSETS", routerConfig: {
    has_user_worker: true, invoke_user_worker_ahead_of_assets: true
  } }
});
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.ODAP_BROWSER_EXECUTABLE, headless: true });
  for (const width of [320, 390, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: "block" });
    await context.route("**/*", async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.hostname === "fonts.googleapis.com" && request.method() === "GET") {
        return route.fulfill({ contentType: "text/css", body: "" });
      }
      if (url.origin !== "https://googlesql.com" || request.method() !== "GET" ||
          !url.pathname.startsWith("/gateway/")) {
        unexpected.push({ method: request.method(), url: request.url() });
        return route.abort();
      }
      const response = await runtime.dispatchFetch(request.url(), { redirect: "manual" });
      return route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers),
        body: Buffer.from(await response.arrayBuffer()) });
    });
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(error.message));
    page.on("requestfailed", request => failures.push({ url: request.url(), error: request.failure()?.errorText }));
    page.on("response", response => {
      if (response.status() >= 400) errors.push(`HTTP ${response.status()}: ${response.url()}`);
    });
    const response = await page.goto("https://googlesql.com/gateway/docs", { waitUntil: "networkidle" });
    assert.equal(response.status(), 200);
    assert((await page.locator('meta[name="description"]').getAttribute("content")).includes("preview limitations"));
    const guides = await page.locator("#guides").innerText();
    for (const text of ["rule-based", "sample schema", "isolated demo", "does not issue an Approval Contract",
      "does not dispatch a BigQuery job", "legacy BigQuery schema importer is disabled in production"])
      assert(guides.includes(text), text);
    const checks = [
      ["Can the site execute live BigQuery jobs?", "raw SQL dry-runs are disabled in production",
        "Adding service-account credentials does not enable them", "Do not switch a production deployment to demo mode"],
      ["What does a structured metric preview confirm?", "does not contact BigQuery",
        "does not estimate warehouse cost", "does not authorize execution"],
      ["Does the preview mean Gateway acceptance is complete?", "not formal Gateway acceptance",
        "separately held-out evaluation", "explicit setup"]
    ];
    for (const [index, [question, ...texts]] of checks.entries()) {
      const detail = page.locator("#faq details").filter({ hasText: question });
      const summary = detail.locator("summary");
      if (index === 0) { await summary.focus(); await summary.press("Enter"); }
      else await summary.click();
      assert(await detail.evaluate(element => element.open));
      const answer = await detail.locator("p").innerText();
      for (const text of texts) assert(answer.includes(text), text);
    }
    assert(!(await page.locator("#faq").innerText()).includes("production path supports live BigQuery dry-runs"));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
    const back = page.locator("header").getByRole("link", { name: "Back to main site", exact: true });
    assert.equal(await back.getAttribute("href"), "https://googlesql.com/");
    await page.locator("#faq").screenshot({ path: resolve(output, `faq-${width}.png`) });
    await page.locator("#guides").screenshot({ path: resolve(output, `guides-${width}.png`) });
    await page.waitForLoadState("networkidle");
    await context.close();
    results.push({ width, disclosures: checks.length, keyboardDisclosure: true, noHorizontalOverflow: true });
  }
  assert.deepEqual(unexpected, []);
  assert.deepEqual(errors, []);
  assert.deepEqual(failures, []);
  writeFileSync(resolve(output, "result.json"), JSON.stringify({ passed: true, results, unexpected, errors, failures,
    stubs: ["Google Fonts stylesheet: empty CSS"] }, null, 2));
  console.log(JSON.stringify({ passed: true, cases: results.length }));
} catch (error) {
  writeFileSync(resolve(output, "result.json"), JSON.stringify({ passed: false, results, unexpected, errors, failures,
    error: error.message }, null, 2));
  throw error;
} finally {
  await browser?.close();
  await runtime.dispose();
}
