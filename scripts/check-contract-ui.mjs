import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { origin, withOfflinePage } from "./offline-ui.mjs";

const shots = fileURLToPath(new URL("../artifacts/contract-ui",import.meta.url));
await mkdir(shots,{recursive:true});
await withOfflinePage(async page => {
  const errors = [], calls = [];
  page.on("pageerror",err => errors.push(err.message));
  let releaseSlow, deny = false;
  const slow = new Promise(done => { releaseSlow = done; });
  await page.addInitScript(() => {
    const get = window.fetch;
    window.fetch = (url,options) => get(url,String(url).endsWith("/contract/slow") ? {...options,signal:undefined} : options);
  });
  await page.route(origin+"/api/control/*/contract/*",async route => {
    const path = new URL(route.request().url()).pathname.split("/");
    const tenantId = path[3], id = path[5];
    calls.push(route.request().method());
    if (id === "slow") await slow;
    const status = id === "absent" ? 404 : id === "sign-in" ? 401 : id === "fault" ? 503 : deny ? 403 : 200;
    const code = {401:"unauthenticated",403:"tenant_access_denied",404:"not_found",503:"control_storage_unavailable"}[status];
    return route.fulfill({status,json:code ? {ok:false,code} : {ok:true,object:{
      tenantId,id,schemaVersion:"0.1",state:id === "past" ? "authorized" : "consumed",expiresAt:"2020-01-01T00:00:00.000Z",
      authority:{mode:"human",reference:"private-fixture-reference"},actionType:"data.read",actionDigest:"sha256:"+"a".repeat(64),
      target:"monthly_revenue",principalId:"private-fixture-subject",agentId:"analyst",reservationId:"private-fixture-reservation",
      semanticReleaseId:"release-12",policyRevision:"policy-7",sourceRevision:"orders-23"
    }}});
  });
  await page.goto(origin+"/approvals");
  await page.getByRole("link",{name:"Inspect approval contract"}).click();
  const tenant = page.getByRole("textbox",{name:"Tenant ID"}), id = page.getByRole("textbox",{name:"Contract ID"});
  const lookup = page.getByRole("button",{name:/^(Refresh|Inspect contract)$/});
  const status = page.getByRole("status");
  async function submit(value) { await id.fill(value); await lookup.click(); }
  const terms = page.getByRole("heading",{name:"Contract terms"});
  await tenant.fill("finance"); await submit("past");
  await terms.waitFor();
  for (const label of ["Authorized","Expired","Not assessed"]) await page.getByText(label,{exact:true}).waitFor();
  assert.doesNotMatch(await page.locator("body").innerText(),/private-fixture/);
  for (const [name,width,height] of [["desktop",1280,900],["mobile",390,844]]) {
    await page.setViewportSize({width,height});
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({path:resolve(shots,name+".png"),fullPage:true});
  }
  const started = page.waitForRequest(r => r.url().endsWith("/contract/slow"));
  await submit("slow"); await started;
  await tenant.fill("second");
  await submit("current");
  await page.getByText("Consumed",{exact:true}).waitFor();
  const finished = page.waitForEvent("requestfinished",{predicate:r=>r.url().endsWith("/contract/slow")});
  releaseSlow(); await finished;
  await page.evaluate(() => new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));
  assert.equal(await status.innerText(),"Contract current in second");
  deny = true; await lookup.click();
  await status.filter({hasText:"do not have access"}).waitFor();
  assert.equal(await terms.count(),0);
  deny = false;
  for (const [value,msg] of [["absent","not found"],["fault","unavailable"],["sign-in","Sign in"]]) {
    await submit(value); await status.filter({hasText:msg}).waitFor();
    assert.equal(await terms.count(),0);
  }
  await status.getByRole("link",{name:"Sign in"}).click();
  await page.locator('a[href="/api/auth/start/github?returnTo=%2Fapproval-contract"]').waitFor();
  assert.deepEqual([...new Set(calls)],["GET"]);
  assert.deepEqual(errors,[]);
  console.log("Contract UI passed: entry, expired versus authorized, lifecycle, scope changes, denials and sign-in return.");
});
