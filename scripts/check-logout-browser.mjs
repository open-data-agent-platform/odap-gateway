import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { Miniflare } from "miniflare";

// Use a mounted production export and synthetic local identity; deny all remote I/O.
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.ODAP_PLAYWRIGHT || "playwright");
const bundler = createRequire(require.resolve("wrangler/package.json"))("esbuild");
const output = resolve(process.argv[2] || "output/playwright/logout");
mkdirSync(output, { recursive: true });
const secret = "synthetic-browser-logout";
const payload = Buffer.from(JSON.stringify({ provider: "google", providerId: "fixture", email: "fixture@example.test",
  name: "Fixture", role: "member", expiresAt: Date.now() + 600000 })).toString("base64url");
const token = payload + "." + createHmac("sha256", secret).update(payload).digest("base64url");
const bundle = await bundler.build({ bundle: true, write: false, format: "esm", platform: "browser", entryPoints: ["worker/index.ts"] });
const config = JSON.parse(readFileSync("wrangler.example.jsonc", "utf8"));
const mf = new Miniflare({ host: "127.0.0.1", port: 0, modules: true, script: bundle.outputFiles[0].text,
  compatibilityDate: config.compatibility_date, bindings: { GATEWAY_MODE: "production", GATEWAY_BASE_PATH: "/gateway",
    AUTH_COOKIE_SECRET: secret }, outboundService: () => { throw new Error("Unexpected remote request"); },
  assets: { directory: resolve("out"), binding: "ASSETS", routerConfig: {
    has_user_worker: true, invoke_user_worker_ahead_of_assets: true
  } } });
let browser;
const results = [];
try {
  const origin = (await mf.ready).origin;
  browser = await chromium.launch({ headless: true, executablePath: process.env.ODAP_BROWSER_EXECUTABLE,
    args: ["--disable-background-networking"] });
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport, serviceWorkers: "block" });
    const errors = [], remoteRequests = [], logoutRequests = [], httpFailures = [], transportFailures = [], stubs = [];
    await context.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (url.hostname === "fonts.googleapis.com" && route.request().method() === "GET") {
        stubs.push("Google Fonts stylesheet: empty local CSS");
        return route.fulfill({ contentType: "text/css", body: "" });
      }
      if (url.origin !== origin) { remoteRequests.push(url.origin); await route.abort(); }
      else await route.continue();
    });
    await context.addCookies([{ name: "odap_gateway_session", value: token, domain: "127.0.0.1", path: "/",
      httpOnly: true, sameSite: "Lax", secure: false }]);
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(error.message));
    page.on("requestfailed", request => transportFailures.push({ url: request.url(), error: request.failure()?.errorText }));
    page.on("response", response => {
      const expectedGetRefusal = new URL(response.url()).pathname === "/gateway/api/auth/logout" &&
        response.request().method() === "GET" && response.status() === 405;
      if (response.status() >= 400 && !expectedGetRefusal)
        httpFailures.push({ url: response.url(), status: response.status() });
    });
    page.on("request", request => {
      if (new URL(request.url()).pathname === "/gateway/api/auth/logout") {
        logoutRequests.push({ method: request.method(), origin: request.headers().origin });
      }
    });
    const cookiePresent = async () => (await context.cookies()).some(cookie => cookie.name === "odap_gateway_session");
    // Off-happy-path checks share the same browser cookie jar.
    const get = await page.goto(origin + "/gateway/api/auth/logout");
    assert.equal(get.status(), 405);
    assert.equal(await cookiePresent(), true);
    const refused = await context.request.post(origin + "/gateway/api/auth/logout", { headers: { Origin: "https://other.test" },
      maxRedirects: 0 });
    assert.equal(refused.status(), 403);
    assert.equal(await cookiePresent(), true);
    await page.goto(origin + "/gateway/login", { waitUntil: "networkidle" });
    let memberHomeDocument = false;
    if (viewport.width >= 640) {
      const account = page.locator('header a[title="fixture@example.test"]');
      await account.waitFor({ state: "visible" });
      const home = page.waitForResponse(response => response.url() === origin + "/gateway" && response.request().isNavigationRequest());
      await account.click();
      assert.equal((await home).status(), 200);
      await page.waitForLoadState("networkidle");
      memberHomeDocument = true;
    }
    const button = page.getByRole("button", { name: "Sign out", exact: true });
    await button.waitFor({ state: "visible" });
    const form = await button.evaluate(element => ({ method: element.form.method, action: element.form.action,
      title: element.title, type: element.type }));
    assert.deepEqual(form, { method: "post", action: origin + "/gateway/api/auth/logout", title: "Sign out", type: "submit" });
    const box = await button.boundingBox();
    assert(box && box.width === 32 && box.height === 32 && box.x >= 0 && box.y >= 0 &&
      box.x + box.width <= viewport.width && box.y + box.height <= viewport.height);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: resolve(output, `before-${viewport.width}.png`) });
    const responsePromise = page.waitForResponse(response => new URL(response.url()).pathname === "/gateway/api/auth/logout" &&
      response.request().method() === "POST");
    if (viewport.width > 500) { await button.focus(); await page.keyboard.press("Enter"); }
    else await button.click();
    const response = await responsePromise;
    assert.equal(response.status(), 303);
    assert.equal(response.headers()["cache-control"], "no-store");
    await page.waitForURL(origin + "/gateway/login?logout=1");
    await page.getByText("Signed out.", { exact: true }).waitFor();
    await page.getByRole("link", { name: "Sign in", exact: true }).waitFor();
    assert.equal(await cookiePresent(), false);
    const guest = await context.request.get(origin + "/gateway/api/auth/session", { maxRedirects: 0 });
    assert.equal(guest.status(), 200);
    assert.equal((await guest.json()).authenticated, false);
    assert.equal(await page.getByRole("button", { name: "Sign out", exact: true }).count(), 0);
    await page.waitForLoadState("networkidle");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: resolve(output, `after-${viewport.width}.png`) });
    assert.deepEqual(logoutRequests, [{ method: "GET", origin: undefined }, { method: "POST", origin }]);
    assert.deepEqual(errors, []);
    assert.deepEqual(remoteRequests, []);
    assert.deepEqual(httpFailures, []);
    assert.deepEqual(transportFailures, []);
    results.push({ viewport, getStatus: get.status(), foreignPostStatus: refused.status(), postStatus: response.status(),
      form, buttonBox: box, cookieCleared: true, guestSession: true, input: viewport.width > 500 ? "keyboard" : "click",
      destination: new URL(page.url()).pathname + new URL(page.url()).search, memberHomeDocument,
      errors, remoteRequests, httpFailures, transportFailures, stubs });
    await context.close();
  }
  writeFileSync(resolve(output, "result.json"), JSON.stringify({ passed: true, results }, null, 2) + "\n");
  console.log(JSON.stringify({ passed: true, viewports: results.length, output }));
} catch (error) {
  writeFileSync(resolve(output, "result.json"), JSON.stringify({ passed: false, results, error: error.message }, null, 2) + "\n");
  throw error;
} finally {
  await browser?.close();
  await mf.dispose();
}
