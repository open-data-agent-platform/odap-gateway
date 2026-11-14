// Mounted local Worker with synthetic browser responses; no production database.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Miniflare } from "miniflare";

const { chromium } = createRequire(import.meta.url)(process.env.ODAP_PLAYWRIGHT || "playwright");
const [bundle, reportPath] = process.argv.slice(2);
assert(bundle && reportPath, "Usage: node scripts/check-dispatch-stop-ui.mjs <Worker bundle> <report>");
const runtime = new Miniflare({ name: "owner-stop-local", host: "127.0.0.1", port: 0, modules: true,
  script: await readFile(bundle, "utf8"), compatibilityDate: "2026-07-01",
  bindings: { GATEWAY_MODE: "production", GATEWAY_BASE_PATH: "/gateway", GATEWAY_SITE_ORIGIN: "https://googlesql.com" },
  assets: { directory: resolve("out"), binding: "ASSETS", routerConfig: { has_user_worker: true, invoke_user_worker_ahead_of_assets: true } } });
const base = { tenantId: "t", intentId: "i", state: "not-stopped", source: "stored-evidence", scope: "local-dispatch-stop",
  providerContacted: false, cancellationConfirmed: false, executionAuthorized: false, settlementAuthorized: false };
const saved = { ...base, state: "stopped", stoppedBy: "google:original-owner", stoppedAt: "2026-01-01T00:00:00.000Z" };
const ack = () => { const value = { ...saved }; delete value.state; delete value.source; return { ok: true, dispatchStop: value }; };
const checks = [], errors = [], external = [], screenshots = [], requests = [];
const check = (name, value) => { assert(value, name); checks.push(name); };
let browser, completed = false;
try {
  const origin = (await runtime.ready).origin;
  browser = await chromium.launch({ executablePath: process.env.ODAP_BROWSER, headless: true,
    args: ["--disable-background-networking", "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.route("**/*", route => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    external.push(route.request().url()); return route.abort();
  });
  const page = await context.newPage(); page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    const fetch = window.fetch;
    window.fetch = (url, options) => fetch(url, String(url).includes("/dispatch-stops") ? { ...options, signal: undefined } : options);
  });
  await page.goto(origin + "/gateway/dispatch-stop");
  const tenant = page.getByRole("textbox", { name: "Tenant ID", exact: true }), intent = page.getByRole("textbox", { name: "Intent ID", exact: true });
  const lookup = page.getByRole("button", { name: /^(Inspect stop|Read again)$/ }), region = page.getByRole("region", { name: "Stored stop evidence" });
  const confirm = region.getByRole("checkbox"), command = region.getByRole("button", { name: "Record stop", exact: true });
  const recovery = region.getByRole("button", { name: "Check stop record", exact: true });
  const status = region.getByRole("status");
  await tenant.fill("t"); await intent.fill("i"); await lookup.click();
  await page.getByRole("status").filter({ hasText: "Sign in to inspect the stop record." }).waitFor();
  check("actual anonymous Worker refuses without controls", await region.count() === 0);
  check("mounted sign-in return", await page.getByRole("link", { name: "Sign in", exact: true }).last().getAttribute("href") === "/gateway/login?returnTo=%2Fdispatch-stop");
  let mode = "success", reads = 0, posts = 0, entered, release;
  await page.route(origin + "/gateway/api/control/*/dispatch-stops**", async route => {
    const req = route.request(); requests.push({ url: req.url(), method: req.method() });
    let body, code = 200;
    if (req.method() === "GET") {
      reads++; let record = posts > 0 ? { ...saved } : { ...base };
      if ((mode === "late-review" && reads === 2) || (mode === "late-readback" && reads === 3)) { entered(); await new Promise(done => { release = done; }); }
      if (["stopped", "legacy-stop", "already-claimed", "already-settled"].includes(mode)) record = mode === "stopped" ? { ...saved } : { ...base, state: mode };
      if (mode === "claim-race" && reads > 1) record.state = "already-claimed";
      if (mode === "revoked" && reads > 1) { code = 403; body = { ok: false, code: "tenant_access_denied" }; }
      if (mode === "damaged" && posts > 0) record.stoppedBy = "other-owner";
      body ??= { ok: true, dispatchStop: record };
    } else {
      assert.equal(req.method(), "POST"); assert.equal(req.postData(), '{"intentId":"i"}'); assert.equal(req.headers().origin, origin); posts++;
      if (mode === "lost") { await route.abort("failed"); return; }
      if (mode === "late-post") { entered(); await new Promise(done => { release = done; }); }
      body = ack();
      const refused = { unauthenticated: [401,"unauthenticated"], denied: [403,"tenant_access_denied"],
        ineligible: [409,"dispatch_stop_unavailable"], storage: [503,"control_storage_unavailable"] }[mode];
      if (refused) { [code] = refused; body = { ok: false, code: refused[1] }; }
      if (mode === "false-cancellation") body.dispatchStop.cancellationConfirmed = true;
    }
    await route.fulfill({ status: code, json: body }).catch(() => {});
  });
  const ready = async (next = "success") => {
    mode = next; reads = 0; posts = 0; await page.reload(); await tenant.fill("t"); await intent.fill("i"); await lookup.click(); await region.waitFor();
  };
  const submit = async () => { await confirm.check(); await command.click(); };
  await ready(); check("confirmation starts unchecked", !(await confirm.isChecked()) && await command.isDisabled());
  check("inspection never writes", posts === 0 && reads === 1);
  await confirm.focus(); await confirm.press("Space"); check("keyboard confirmation enables", await command.isEnabled());
  await mkdir("output/playwright", { recursive: true });
  const capture = async (kind, width) => {
    await page.setViewportSize({ width, height: 1000 });
    check(kind + " page fits " + width, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    check(kind + " buttons fit " + width, await region.getByRole("button").evaluateAll(elements => elements.every(e => e.scrollWidth <= e.clientWidth)));
    const path = "output/playwright/owner-stop-" + kind + "-" + width + ".png"; await page.screenshot({ path, fullPage: true }); screenshots.push(path);
  };
  for (const width of [1440,320]) await capture("confirm", width);
  await command.click({ clickCount: 2 }); await status.filter({ hasText: /^Stop recorded$/ }).waitFor();
  check("double click submits once then reads back", posts === 1 && reads === 3);
  check("original actor and time shown", (await region.innerText()).includes(saved.stoppedBy) && (await region.innerText()).includes(saved.stoppedAt));
  check("command remains locked", await command.isDisabled() && await confirm.count() === 0);
  await recovery.click(); await status.filter({ hasText: /^Stop recorded$/ }).waitFor();
  check("recovery is read-only", posts === 1 && reads === 4);
  for (const width of [1440,768,390,320]) await capture("result", width);
  for (const state of ["stopped","legacy-stop","already-claimed","already-settled"]) {
    await ready(state); check(state + " has no command", await command.count() === 0 && await confirm.count() === 0 && posts === 0);
    if (state === "legacy-stop") check("legacy attribution not invented", !(await region.innerText()).includes("Original stopper"));
  }
  for (const [state, message] of [["unauthenticated","Sign in to inspect"],["denied","current tenant owner"],["ineligible","Stored state changed"],
    ["storage","Stop not verified"],["false-cancellation","Stop not verified"],["damaged","Stop not verified"]]) {
    await ready(state); await submit(); await status.filter({ hasText: message }).waitFor();
    check(state + " never auto retries", posts === 1 && await command.isDisabled() && await confirm.count() === 0);
  }
  await ready("lost"); await submit(); await status.filter({ hasText: "Stop not verified" }).waitFor();
  check("lost response stays uncertain", posts === 1); await recovery.click(); await status.filter({ hasText: /^Stop recorded$/ }).waitFor();
  check("lost response recovers without POST", posts === 1 && reads === 3);
  for (const state of ["revoked","claim-race"]) {
    await ready(state); await submit(); await status.filter({ hasText: state === "revoked" ? "current tenant owner" : "Stored state changed" }).waitFor();
    check(state + " blocks command after fresh read", posts === 0);
  }
  await ready(); await confirm.check(); await lookup.click(); await region.waitFor();
  check("reread clears confirmation", !(await confirm.isChecked()) && await command.isDisabled());
  await confirm.check(); await tenant.fill("peer"); check("scope edit clears private result", await region.count() === 0 && posts === 0);
  for (const state of ["late-review","late-post","late-readback"]) {
    await ready(state); const waiting = new Promise(done => { entered = done; }); await submit(); await waiting;
    await intent.fill("other"); release(); await page.waitForTimeout(250);
    check(state + " cannot revive cleared scope", await region.count() === 0);
    check(state + " has no extra writes", posts === (state === "late-review" ? 0 : 1));
  }
  await ready(); await confirm.check(); await region.getByRole("button", { name: "Hide evidence" }).click(); check("hide clears confirmation", await region.count() === 0);
  await ready(); await confirm.check(); await page.evaluate(() => dispatchEvent(new Event("pagehide"))); await region.waitFor({ state: "detached" }); check("pagehide clears", true);
  await ready(); await confirm.check(); await page.evaluate(() => { Object.defineProperty(document,"hidden",{ configurable:true,value:true }); document.dispatchEvent(new Event("visibilitychange")); });
  await region.waitFor({ state: "detached" }); check("hidden document clears", true);
  await page.evaluate(() => Object.defineProperty(document,"hidden",{ configurable:true,value:false }));
  await ready(); await confirm.check(); await page.getByRole("link", { name: "Job recovery", exact: true }).click();
  await page.getByRole("heading", { name: "Job recovery", exact: true }).waitFor(); check("navigation removes stop control", await region.count() === 0);
  for (const target of ["job-recovery","cancellation-evidence"]) {
    await page.goto(origin + "/gateway/" + target);
    check(target + " navigation to stop", await page.getByRole("link", { name: "Pre-dispatch stop", exact: true }).getAttribute("href") === "/gateway/dispatch-stop");
  }
  await page.goto(origin + "/gateway/dispatch-stop"); await tenant.fill("x".repeat(128)); await intent.fill("y".repeat(128));
  check("long input fits mobile", await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  check("no private browser storage", await page.evaluate(() => localStorage.length === 0 && sessionStorage.length === 0));
  check("only existing font requests blocked", external.every(url => new URL(url).origin === "https://fonts.googleapis.com"));
  check("no page errors", errors.length === 0); await context.close(); completed = true;
} finally {
  if (browser) await browser.close(); await runtime.dispose();
  await writeFile(reportPath, JSON.stringify({ passed: completed && errors.length === 0, checks, errors, screenshots, blockedExternal: external,
    requests, productionDatabase: false, browserClosed: true, runtimeDisposed: true }, null, 2) + "\n");
}
console.log(JSON.stringify({ passed: true, checks: checks.length }));
