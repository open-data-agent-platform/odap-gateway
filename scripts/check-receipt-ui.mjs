import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { origin, withOfflinePage } from "./offline-ui.mjs";

const shots = fileURLToPath(new URL("../artifacts/receipt-ui",import.meta.url));
await mkdir(shots,{recursive:true});
await withOfflinePage(async page => {
  let blocked = false;
  let mode = "corrected", reads = 0, resume;
  const errors = [], calls = [];
  page.on("pageerror",e => errors.push(e.message));
  const issued = "The query completed.";
  const corrected = "Only the recorded query completed. Downstream checks were not part of this job.";
  let latest = {revision:2,correctedReason:corrected}, writeMode = "conflict";
  const writes = [];
  const historicalReads = [], history = new Map();
  await page.route(origin + "/api/control/*/receipt-corrections/**",async route => {
    const req = route.request();
    if (req.method() === "GET") {
      const url = new URL(req.url());
      assert.equal(url.pathname,"/api/control/synthetic-finance/receipt-corrections/succeeded");
      assert.match(url.search,/^\?revision=[1-9]\d*$/);
      const n = Number(url.searchParams.get("revision"));
      historicalReads.push(n);
      return history.has(n) ? route.fulfill({json:{ok:true,correction:history.get(n)}}) :
        route.fulfill({status:404,json:{ok:false,code:"receipt_correction_unavailable"}});
    }
    assert.equal(req.method(),"POST");
    assert.equal(req.url(),origin+"/api/control/synthetic-finance/receipt-corrections/succeeded");
    assert.equal(req.headers().origin,origin);
    const command = req.postDataJSON();
    assert.deepEqual(Object.keys(command).sort(),["correctedReason","evidenceRef","expectedRevision"]);
    writes.push(command);
    if (writeMode === "conflict") {
      latest = {revision:3,correctedReason:"Another owner clarified the scope."};
      return route.fulfill({status:409,json:{ok:false,code:"receipt_correction_conflict"}});
    }
    assert.equal(command.expectedRevision,latest.revision);
    latest = {revision:latest.revision+1,correctedReason:command.correctedReason};
    const saved = {tenantId:"synthetic-finance",receiptId:"succeeded",...latest,
      evidenceRef:command.evidenceRef,actor:"demo-owner",recordedAt:"2026-01-01T00:00:00.000Z"};
    history.set(saved.revision,saved);
    if (writeMode === "lost") {
      latest = {revision:latest.revision+1,correctedReason:"A later owner's clarification"};
      return route.abort("failed");
    }
    return route.fulfill({json:{ok:true,correction:saved}});
  });
  await page.route(origin + "/api/control/*/receipt-explanations/**",async route => {
    const url = new URL(route.request().url()), [, , , tenantId, , id] = url.pathname.split("/");
    assert.equal(route.request().method(),"GET");
    assert.equal(url.search,"");
    reads++;
    if (mode === "pending") await new Promise(resolve => { resume = resolve; });
    const failure = { ownerOnly:[403,"receipt_correction_denied"], signedOut:[401,"unauthenticated"],
      missing:[404,"not_found"], broken:[503,"control_storage_unavailable"] }[mode];
    if (failure) return route.fulfill({status:failure[0],json:{ok:false,code:failure[1]}});
    return route.fulfill({json:{ok:true,object:{tenantId,id,issuedReason:issued,
      latest:mode === "empty" ? null : latest}}});
  });
  await page.route(origin + "/api/control/*/receipt/**",async route => {
    const url = new URL(route.request().url()), [, , , tenantId, , id] = url.pathname.split("/");
    calls.push([route.request().method(),url.search]);
    const code = blocked ? "tenant_access_denied" : id === "signed_out" ? "unauthenticated" : null;
    if (code) return route.fulfill({status:blocked ? 403 : 401,json:{ok:false,code}});
    return route.fulfill({json:{ok:true,summary:{tenantId,id,outcome:id,recordedAt:"2026-01-01T00:00:00.000Z",
      hasContract:id !== "denied",hasSemanticRelease:id !== "denied"}}});
  });
  await page.goto(origin + "/evidence-coverage");
  await page.getByText("Demo owner",{exact:true}).waitFor();
  await page.getByRole("link",{name:"Inspect evidence receipt"}).click();
  await page.waitForURL(origin + "/evidence-receipt");
  await page.getByText("Demo owner",{exact:true}).waitFor();
  await page.getByRole("textbox",{name:"Tenant ID"}).fill("synthetic-finance");
  const id = page.getByRole("textbox",{name:"Receipt ID"});
  const lookup = page.getByRole("button",{name:/^(Inspect receipt|Refresh)$/});
  const status = page.getByRole("status");
  for (const [key,label] of [["pending","Pending"],["failed","Failed"],["cancelled","Cancelled"],["denied","Denied"],["succeeded","Succeeded"]]) {
    await id.fill(key); await lookup.click();
    await page.getByText(label,{exact:true}).waitFor();
    await page.getByText("Not verified by this receipt",{exact:true}).waitFor();
    assert.equal(await page.getByText(key === "denied" ? "Not recorded" : "Present",{exact:true}).count(),2);
    assert.equal(new URL(page.url()).pathname,"/evidence-receipt");
    assert.equal(new URL(page.url()).search,"");
  }
  assert.equal(reads,0);
  const reveal = page.getByRole("button",{name:"View reasons"}), hide = page.getByRole("button",{name:"Hide reasons"});
  await reveal.click();
  await page.getByText(issued,{exact:true}).waitFor();
  await page.getByText(corrected,{exact:true}).waitFor();
  for (const [name,width,height] of [["desktop",1280,900],["mobile",390,844]]) {
    await page.setViewportSize({width,height});
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    const a = await page.getByText(issued,{exact:true}).boundingBox(), b = await page.getByText(corrected,{exact:true}).boundingBox();
    assert.ok(a && b && (width > 640 ? b.x >= a.x + a.width : b.y >= a.y + a.height));
    await page.screenshot({path:resolve(shots,name+".png"),fullPage:true});
  }
  const add = page.getByRole("button",{name:"Add correction"}), save = page.getByRole("button",{name:"Submit correction"});
  const reason = page.getByLabel("Corrected reason",{exact:true}), evidence = page.getByLabel("Evidence reference",{exact:true});
  const reread = page.getByRole("button",{name:"Read latest reasons"});
  await add.click();
  await reason.fill("Discard me"); await evidence.fill("not a reference");
  assert.ok(await save.isDisabled());
  await page.getByRole("button",{name:"Cancel",exact:true}).click();
  assert.equal(writes.length,0);
  for (const [result,base,draft,message] of [
    ["conflict",2,"First draft","The revision has changed."],
    ["lost",3,"Second clarification","Submission not confirmed."],
    ["saved",5,"Final clarification","Correction recorded as revision 6."]
  ]) {
    writeMode = result;
    await add.click();
    await page.getByText("Correcting revision "+base,{exact:true}).waitFor();
    assert.equal(await reason.inputValue(),"");
    assert.equal(await evidence.inputValue(),"");
    await reason.fill(draft); await evidence.fill("ticket:42");
    if (result === "conflict") {
      for (const [name,width,height] of [["desktop",1280,900],["mobile",390,844]]) {
        await page.setViewportSize({width,height});
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await page.screenshot({path:resolve(shots,"correction-"+name+".png"),fullPage:true});
      }
    }
    const prior = writes.length, priorReads = reads;
    await page.getByRole("form",{name:"Receipt correction"}).evaluate(form => { form.requestSubmit(); form.requestSubmit(); });
    await page.getByRole("status").filter({hasText:message}).waitFor();
    assert.equal(writes.length,prior+1);
    assert.deepEqual(writes.at(-1),{expectedRevision:base,correctedReason:draft,evidenceRef:"ticket:42"});
    assert.equal(reads,priorReads);
    assert.equal(await save.count(),0);
    assert.equal(await add.count(),0);
    if (result === "lost") {
      const number = page.getByRole("spinbutton",{name:"Revision number"});
      assert.equal(await number.inputValue(),"4");
      assert.equal(historicalReads.length,0);
      await page.getByRole("button",{name:"Inspect revision"}).click();
      const past = page.getByRole("region",{name:"Historical correction"});
      await past.getByRole("heading",{name:"Historical correction (revision 4)"}).waitFor();
      for (const text of [draft,"demo-owner","ticket:42"]) await past.getByText(text,{exact:true}).waitFor();
      assert.equal(reads,priorReads);
      assert.equal(await add.count(),0);
      assert.equal(await save.count(),0);
      for (const [name,width,height] of [["desktop",1280,900],["mobile",390,844]]) {
        await page.setViewportSize({width,height});
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await page.screenshot({path:resolve(shots,"history-"+name+".png"),fullPage:true});
      }
      await number.fill("42");
      await page.getByRole("button",{name:"Inspect revision"}).click();
      await page.getByRole("status").filter({hasText:"No verified record"}).waitFor();
      assert.equal(await past.count(),0);
      assert.equal(await page.getByText(draft,{exact:true}).count(),0);
      assert.equal(await add.count(),0);
      assert.deepEqual(historicalReads,[4,42]);
    }
    await reread.click();
    await page.getByText(latest.correctedReason,{exact:true}).waitFor();
    await page.getByText(issued,{exact:true}).waitFor();
    assert.equal(writes.length,prior+1);
  }
  await hide.click(); mode = "empty"; await reveal.click();
  await page.getByText("No correction recorded.",{exact:true}).waitFor();
  await hide.click();
  for (const [state,message] of [["ownerOnly","Only a current tenant owner can view reasons."],
    ["signedOut","Sign in again to view reasons."],["missing","Receipt reasons are not available for this receipt."],
    ["broken","Could not read receipt reasons. Try again."]]) {
    mode = state; await reveal.click(); await page.getByText(message,{exact:true}).waitFor();
    for (const text of [issued,corrected,"No correction recorded."])
      assert.equal(await page.getByText(text,{exact:true}).count(),0);
  }
  mode = "pending";
  const sent = page.waitForRequest(req => req.url().includes("/receipt-explanations/"));
  await reveal.click(); await sent;
  await id.fill("failed");
  await lookup.click();
  await page.getByText("Failed",{exact:true}).waitFor();
  resume(); await reveal.waitFor();
  assert.equal(await page.getByText(issued,{exact:true}).count(),0);
  blocked = true; await lookup.click();
  await status.filter({hasText:"do not have access"}).waitFor();
  assert.equal(await page.getByText("Recorded outcome",{exact:true}).count(),0);
  blocked = false; await id.fill("signed_out"); await lookup.click();
  await status.getByRole("link",{name:"Sign in"}).click();
  await page.locator('a[href="/api/auth/start/github?returnTo=%2Fevidence-receipt"]').waitFor();
  assert.ok(calls.length >= 7 && calls.every(([method,query]) => method === "GET" && query === "?view=summary"));
  assert.deepEqual(errors,[]);
  assert.equal(writes.length,3);
  console.log("Receipt UI passed: private reads, explicit version-bound submissions, conflict and lost-ack recovery, desktop/mobile layout.");
});
