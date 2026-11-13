// Local mounted Worker smoke: synthetic browser responses, no database or external network.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { Miniflare } from "miniflare";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.ODAP_PLAYWRIGHT || "playwright");
const [bundle, reportPath] = process.argv.slice(2);
assert(bundle && reportPath, "Usage: node scripts/check-settled-evidence-ui.mjs <Worker bundle> <report>");
const compiled = await build({ entryPoints: ["tests/fixtures/settled-inspection.ts"], bundle: true, platform: "node", format: "esm", write: false });
const { settledInspectionFixture } = await import("data:text/javascript;base64," + Buffer.from(compiled.outputFiles[0].text).toString("base64"));
const runtime = new Miniflare({ name: "settled-ui-local", host: "127.0.0.1", port: 0, modules: true,
  script: await readFile(bundle, "utf8"), compatibilityDate: "2026-07-01",
  bindings: { GATEWAY_MODE: "production", GATEWAY_BASE_PATH: "/gateway", GATEWAY_SITE_ORIGIN: "https://googlesql.com" },
  assets: { directory: resolve("out"), binding: "ASSETS", routerConfig: { has_user_worker: true, invoke_user_worker_ahead_of_assets: true } } });
let browser, completed = false;
const checks = [], errors = [], external = [], requests = [];
const check = (name, value) => { assert(value, name); checks.push(name); };
try {
  const origin = (await runtime.ready).origin;
  browser = await chromium.launch({ executablePath: process.env.ODAP_BROWSER, headless: true,
    args: ["--disable-background-networking", "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"] });
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 1000 } });
  await context.route("**/*", route => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    external.push(route.request().url()); return route.abort();
  });
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    window.__downloads = { made: 0, revoked: 0 };
    const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL), fetch = window.fetch;
    URL.createObjectURL = blob => { window.__downloads.made++; return create(blob); };
    URL.revokeObjectURL = url => { window.__downloads.revoked++; revoke(url); };
    // Exercise the hook's stale-result guard even when the underlying fetch ignores abort.
    window.fetch = (url, options) => fetch(url, String(url).includes("/settled-evidence/") ? { ...options, signal: undefined } : options);
  });
  await page.goto(origin + "/gateway/settled-evidence");
  await page.getByRole("heading", { name: "Settled evidence", exact: true }).waitFor();
  const tenant = page.getByRole("textbox", { name: "Tenant ID", exact: true }), intent = page.getByRole("textbox", { name: "Intent ID", exact: true });
  const submit = page.getByRole("button", { name: /^(Read settled evidence|Read again)$/ });
  const region = page.getByRole("region", { name: "Settled evidence bundle" });
  const status = page.getByRole("status");
  const fill = async () => { await tenant.fill("t"); await intent.fill("i"); };
  const ready = async () => { await fill(); await submit.click(); await region.waitFor(); };
  await fill(); await submit.click(); await status.filter({ hasText: "Sign in to read settled evidence." }).waitFor();
  check("actual anonymous Worker refuses", await region.count() === 0);
  check("mounted sign-in return path", await page.getByRole("link", { name: "Sign in", exact: true }).last().getAttribute("href") === "/gateway/login?returnTo=%2Fsettled-evidence");
  check("no automatic download", (await page.evaluate(() => window.__downloads)).made === 0);
  let body = (await settledInspectionFixture()).body, statusCode = 200, delay;
  await page.route(origin + "/gateway/api/control/*/settled-evidence/*", async route => {
    requests.push({ url: route.request().url(), method: route.request().method() });
    const response = { status: statusCode, json: structuredClone(body) }, hold = delay;
    if (hold) await hold;
    await route.fulfill(response).catch(() => {});
  });
  await ready();
  check("issuer remains unauthenticated", await region.getByText("Not established", { exact: true }).count() === 1);
  check("recorded integer charge", await region.getByText("12 micro-USD", { exact: true }).count() === 1);
  for (const [label, content, suffix] of [["Download JSON", body.evidence.json, ".json"], ["Download checksum", body.evidence.digest + "\n", ".sha256"]]) {
    const pending = page.waitForEvent("download"); await page.getByRole("button", { name: label, exact: true }).click(); const download = await pending;
    check(label + " filename", download.suggestedFilename() === "settled-evidence-" + body.evidence.digest.slice(7) + suffix);
    const bytes = await readFile(await download.path());
    check(label + " exact bytes", bytes.equals(Buffer.from(content, "utf8")));
    if (suffix === ".json") check("download SHA-256", "sha256:" + createHash("sha256").update(bytes).digest("hex") === body.evidence.digest);
  }
  await page.waitForFunction(() => window.__downloads.revoked === 2);
  check("object URLs released", (await page.evaluate(() => window.__downloads)).made === 2);
  await mkdir("output/playwright", { recursive: true });
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    check("no horizontal overflow " + width, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    check("download buttons fit " + width, await page.getByRole("button", { name: "Download checksum" }).evaluate(e => e.scrollWidth <= e.clientWidth));
    await page.screenshot({ path: "output/playwright/settled-ui-" + width + ".png", fullPage: true });
  }
  await page.getByRole("button", { name: "Hide evidence" }).click(); check("explicit hide clears", await region.count() === 0);
  await ready(); await tenant.fill("other"); check("scope edit clears", await region.count() === 0);
  await ready(); await page.evaluate(() => dispatchEvent(new Event("pagehide"))); await region.waitFor({ state: "detached" }); check("pagehide clears", true);
  await ready(); await page.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, value: true }); document.dispatchEvent(new Event("visibilitychange")); });
  await region.waitFor({ state: "detached" }); check("hidden document clears", true);
  await page.evaluate(() => Object.defineProperty(document, "hidden", { configurable: true, value: false }));
  await ready(); statusCode = 403; await submit.click(); await status.filter({ hasText: "current tenant owner access is missing" }).waitFor();
  check("reread denial clears bundle", await region.count() === 0);
  for (const [code, payload, message] of [
    [401, { ok: false }, "Sign in to read"], [503, { ok: false, code: "delegation_not_configured" }, "not configured"],
    [503, { ok: false, code: "control_storage_unavailable" }, "No consistent"], [200, { ok: true }, "No consistent"],
    [200, { ...body, evidence: { ...body.evidence, digest: "sha256:" + "0".repeat(64) } }, "No consistent"]]) {
    statusCode = code; body = payload; await fill(); await submit.click(); await status.filter({ hasText: message }).waitFor();
    check("refusal withholds bundle " + checks.length, await region.count() === 0);
  }
  for (const outcome of ["failed", "cancelled"]) {
    statusCode = 200; body = (await settledInspectionFixture(outcome, 125)).body; await ready();
    check(outcome + " outcome", await region.getByRole("heading", { name: outcome === "failed" ? "Failure recorded" : "Cancellation recorded" }).count() === 1);
  }
  body = (await settledInspectionFixture()).body; let release;
  delay = new Promise(done => { release = done; }); await fill(); const before = requests.length; await submit.click();
  while (requests.length === before) await new Promise(done => setTimeout(done, 10));
  await tenant.fill("changed"); release(); delay = undefined;
  await page.waitForFunction(() => !document.querySelector('button[type="submit"]').disabled);
  await page.waitForTimeout(250); check("late aborted lookup stays hidden", await region.count() === 0);
  await ready();
  await page.evaluate(() => { URL.createObjectURL = () => { throw new Error("Synthetic blocked download"); }; });
  await page.getByRole("button", { name: "Download JSON", exact: true }).click(); await region.getByRole("alert").waitFor(); check("download failure visible", true);
  await intent.fill("x".repeat(128)); await tenant.fill("y".repeat(128));
  check("long valid IDs fit mobile", await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  check("no private browser storage", await page.evaluate(() => localStorage.length === 0 && sessionStorage.length === 0));
  check("read-only calls only", requests.length > 0 && requests.every(r => r.method === "GET"));
  check("only existing font requests blocked", external.every(url => new URL(url).origin === "https://fonts.googleapis.com"));
  check("no page exceptions", errors.length === 0);
  for (const target of ["job-recovery", "evidence-receipt"]) {
    await page.goto(origin + "/gateway/" + target);
    check(target + " mounted export navigation", await page.getByRole("link", { name: "Settled evidence", exact: true }).getAttribute("href") === "/gateway/settled-evidence");
  }
  await context.close();
  completed = true;
} finally {
  if (browser) await browser.close();
  await runtime.dispose();
  await writeFile(reportPath, JSON.stringify({ passed: completed && checks.length === 40 && errors.length === 0, checks,
    errors, blockedExternal: external, requests, productionDatabase: false, browserClosed: true, runtimeDisposed: true }, null, 2) + "\n");
}
assert.equal(checks.length, 40);
console.log(JSON.stringify({ passed: true, checks: checks.length }));
