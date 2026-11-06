import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { origin, withOfflinePage } from "./offline-ui.mjs";

const shots = fileURLToPath(new URL("../artifacts/workbench-preview-ui",import.meta.url));
await mkdir(shots,{recursive:true});
await withOfflinePage(async page => {
  const errors = [], calls = [];
  page.on("pageerror",e => errors.push(e.message));
  let scenario = "live", release;
  const slow = new Promise(done => {release = done;});
  await page.addInitScript(() => {
    const original = window.fetch;
    window.fetch = (url,opts) => original(url, String(url).endsWith("/api/query/dry-run") ? {...opts,signal:undefined} : opts);
  });
  await page.route(origin+"/api/query/dry-run",async route => {
    const kind = scenario, req = route.request();
    calls.push({method:req.method(),...req.postDataJSON()});
    if (kind === "slow") await slow;
    if (kind === "network") return route.abort();
    if (kind === "malformed") return route.fulfill({json:{ok:true,preview:{status:"approved"}}});
    const sample = {status:"approved",gateLabel:"Dry run approved",mode:kind === "simulation" ? "simulated" : "live",
      scannedBytes:8192,estimatedCostUsd:0.01,expectedRuntimeMs:20,referencedTables:["fixture.orders"],projectedColumns:1,
      checks:[{label:"Fixture check",detail:"Fixture detail",status:"pass"}],persisted:true,runId:"fixture-audit"};
    const status = {deny:403,auth:401,down:503}[kind] || 200;
    return route.fulfill({status,json:{ok:status === 200,preview:sample,message:"private_fixture_error"}});
  });
  await page.goto(origin+"/sql");
  await page.getByRole("heading",{name:"Sample review queue"}).waitFor();
  const run = page.getByRole("button",{name:"Dry run",exact:true});
  const alert = page.getByRole("alert").filter({hasText:/Dry run denied|Dry-run result unavailable|Sign in to request/});
  const editor = page.getByRole("textbox",{name:"Editable SQL"});
  await page.getByText("Draft estimate",{exact:true}).waitFor();
  for (const [kind,label] of [["live","Dry run passed"],["simulation","Simulation complete"]]) {
    scenario = kind; await run.click();
    await page.getByText(label,{exact:true}).waitFor();
    assert.equal(await page.getByText("Draft estimate",{exact:true}).count(),0);
  }
  for (const [kind,label] of [["deny","Dry run denied."],["down","Dry-run result unavailable."],
    ["malformed","Dry-run result unavailable."],["network","Dry-run result unavailable."]]) {
    scenario = kind; await run.click();
    await alert.filter({hasText:label}).waitFor();
    assert.doesNotMatch(await page.locator("body").innerText(),/Dry run approved|Dry run passed|Simulation complete|fixture-audit|Draft estimate|private_fixture_error/i);
    if (kind === "deny") {
      for (const [name,width,height] of [["desktop",1280,900],["mobile",390,844]]) {
        await page.setViewportSize({width,height});
        await alert.scrollIntoViewIfNeeded();
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await page.screenshot({path:join(shots,name+".png")});
      }
    }
  }
  scenario = "slow";
  const request = page.waitForRequest(r => r.url().endsWith("/api/query/dry-run"));
  await run.click(); await request;
  await editor.fill("SELECT 2");
  await page.getByText("Draft estimate",{exact:true}).waitFor();
  const finished = page.waitForEvent("requestfinished",{predicate:r=>r.url().endsWith("/api/query/dry-run")});
  release(); await finished;
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  assert.equal(await page.getByText("Dry run passed",{exact:true}).count(),0);
  assert.equal(await editor.inputValue(),"SELECT 2");
  await editor.fill(" ");
  assert.ok(await run.isDisabled());
  await editor.fill("SELECT 3");
  scenario = "auth"; await run.click();
  await alert.getByRole("link",{name:"Sign in"}).click();
  await page.locator('a[href="/api/auth/start/github?returnTo=%2Fsql"]').waitFor();
  assert.equal(calls.at(-1).sql,"SELECT 3");
  assert.ok(calls.every(c => c.method === "POST"));
  assert.deepEqual(errors,[]);
  console.log("Workbench passed: server decisions, invalid/network responses, stale SQL, blank draft and sign-in return.");
});
