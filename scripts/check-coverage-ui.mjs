// Offline smoke test against an existing static export. No HTTP server or real session.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { origin, withOfflinePage } from "./offline-ui.mjs";

const shots = fileURLToPath(new URL("../artifacts/coverage-ui",import.meta.url));
const empty = { recordedAttempts:0,admitted:0,missingReleaseRefusals:0,pendingOutcome:0,pendingBilling:0,
  attributedSettlements:0,unattributedSettlements:0,missingEvidence:0 };
const report = { ...empty,recordedAttempts:10,admitted:8,missingReleaseRefusals:2,
  attributedSettlements:4,pendingOutcome:1,pendingBilling:2,missingEvidence:1 };

async function main() {
  await mkdir(shots,{recursive:true});
  await withOfflinePage(async page => {
    const errors = [];
    page.on("pageerror",err => errors.push(err.message));
    let denyRefresh = false, releaseSlow;
    const release = new Promise(done => { releaseSlow = done; });
    await page.addInitScript(() => {
      // Force one response to complete after a tenant edit even if its signal was aborted.
      const original = window.fetch;
      window.fetch = (url, options) => original(url, String(url).includes("/control/slow/")
        ? { ...options,signal:undefined } : options);
    });
    await page.route(origin+"/api/control/*/evidence-coverage",async route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      const tenant = /^\/api\/control\/([^/]+)\/evidence-coverage$/.exec(url.pathname)?.[1];
      if (tenant) {
        assert.equal(route.request().method(),"GET");
        if (tenant === "slow") await release;
        const status = { expired:401, denied:403, fault:503 }[tenant] || (tenant === "demo" && denyRefresh ? 403 : 200);
        return route.fulfill({status,json:status === 200 ? {ok:true,coverage:tenant === "empty" ? empty : report} : {ok:false}});
      }
      return route.abort();
    });
    await page.goto(origin+"/evidence-coverage");
    const input = page.getByRole("textbox",{name:"Tenant ID"});
    const button = page.getByRole("button",{name:/^(Refresh|View coverage)$/});
    const status = page.getByRole("status");
    const submit = async tenant => { await input.fill(tenant); await button.click(); };
    const message = async text => { await status.filter({hasText:text}).waitFor(); };
    await submit("demo");
    await message("Coverage for demo");
    assert.equal(await page.getByRole("row",{name:"Attributed settlements 4",exact:true}).count(),1);
    for (const [name,width,height] of [["desktop",1280,900],["mobile",390,844]]) {
      await page.setViewportSize({width,height});
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
      await page.screenshot({path:resolve(shots,name+".png"),fullPage:true});
    }
    denyRefresh = true;
    await button.click();
    await message("Owner access is required");
    assert.equal(await page.getByRole("table").count(),0);
    const started = page.waitForRequest(r=>r.url().includes("/control/slow/"));
    await submit("slow");
    await started;
    await submit("empty");
    await message("No recorded attempts for empty");
    const ended = page.waitForEvent("requestfinished",{predicate:r=>r.url().includes("/control/slow/")});
    releaseSlow();
    await ended;
    await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
    assert.match(await status.innerText(),/No recorded attempts for empty/);
    for (const [tenant,text] of [["denied","Owner access is required"],["fault","Coverage is unavailable"],["expired","Sign in to view"]]) {
      await submit(tenant);
      await message(text);
      assert.equal(await page.getByRole("table").count(),0);
    }
    assert.equal(await status.getByRole("link",{name:"Sign in"}).getAttribute("href"),"/login?returnTo=%2Fevidence-coverage");
    await page.goto(origin+"/login?returnTo=%2Fevidence-coverage");
    await page.locator('a[href="/api/auth/start/github?returnTo=%2Fevidence-coverage"]').waitFor();
    assert.deepEqual(errors,[]);
    console.log("Coverage UI passed: desktop, mobile, counts, refresh denial, stale response, empty, 401/403/503.");
  });
}
main().catch(err => { console.error(err); process.exitCode = 1; });
