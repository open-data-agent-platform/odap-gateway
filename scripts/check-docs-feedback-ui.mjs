import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { origin, withOfflinePage } from "./offline-ui.mjs";

const baseline = process.argv.includes("--baseline"), results = [];
const output = fileURLToPath(new URL("../output/playwright/docs-feedback",import.meta.url));
const verification = fileURLToPath(new URL("../.tmp/verification",import.meta.url));
await mkdir(output,{recursive:true});
await mkdir(verification,{recursive:true});
await withOfflinePage(async page => {
  page.setDefaultTimeout(5000);
  const errors = [], requests = [];
  page.on("pageerror",e => errors.push(e.message));
  let getMode = "empty", postMode = "success", releaseGet, releasePost;
  let waitGet = Promise.resolve(), waitPost = Promise.resolve();
  const question = {id:"stored-question",kind:"question",topic:"Governance",authorName:"Reader",
    message:"A stored approved question.",status:"approved",createdAt:"2026-11-06T00:00:00.000Z"};
  await page.route(origin+"/api/docs/feedback",async route => {
    const req = route.request();
    requests.push(req.method());
    if (req.method() === "GET") {
      const mode = getMode;
      if (mode === "slow") await waitGet;
      if (mode === "network") return route.abort();
      if (mode === "error") return route.fulfill({status:503,json:{ok:false,message:"private_load_error"}});
      if (mode === "malformed") return route.fulfill({json:{ok:true,persisted:true,feedback:[{id:"broken"}]}});
      return route.fulfill({json:{ok:true,persisted:mode !== "unconfigured",storageBinding:mode === "unconfigured" ? null : "DB",
        feedback:mode === "approved" ? [question] : []}});
    }
    const mode = postMode, input = req.postDataJSON();
    if (mode === "slow") await waitPost;
    if (mode === "network") return route.abort();
    const success = {ok:true,accepted:true,pendingReview:true,persisted:true,storageBinding:"DB",
      feedback:{...question,id:"submitted-question",kind:input.kind,topic:input.topic,authorName:input.authorName,
        message:input.message,status:"pending"}};
    if (/^\d+$/.test(mode)) return route.fulfill({status:Number(mode),json:{...success,message:"private_submit_error"}});
    if (mode === "malformed") return route.fulfill({json:{ok:true,persisted:true,feedback:{id:"broken",message:input.message}}});
    if (mode === "html") return route.fulfill({contentType:"text/html",body:"<html>Sign in</html>"});
    if (mode === "preview") return route.fulfill({json:{...success,persisted:false}});
    if (mode === "honeypot") return route.fulfill({json:{...success,persisted:false,feedback:null}});
    return route.fulfill({json:success});
  });
  const settled = () => page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  const section = page.locator("#community"), form = section.locator("form"), message = form.getByRole("textbox",{name:/^Message/});
  const submit = form.getByRole("button",{name:"Submit for review",exact:true});
  const draft = "Please explain how a release is reviewed.";
  const load = async mode => {
    getMode = mode;
    const response = page.waitForResponse(r => r.url().endsWith("/api/docs/feedback") && r.request().method() === "GET");
    await page.goto(origin+"/docs");
    await response;
    await settled();
  };
  const fill = async () => {
    await form.getByRole("combobox",{name:/^Type/}).selectOption("comment");
    await form.getByRole("combobox",{name:/^Topic/}).selectOption("Governance");
    await form.getByLabel("Name",{exact:true}).fill("Draft reader");
    await form.getByLabel("Email",{exact:true}).fill("draft@example.test");
    await message.fill(draft);
  };
  const test = async (name,run) => {
    try {await run();results.push({name,passed:true});}
    catch (error) {results.push({name,passed:false,error:error.message});}
    console.log(JSON.stringify(results.at(-1)));
    if (!results.at(-1).passed && process.argv.includes("--fail-fast")) {
      await page.screenshot({path:join(output,"failure.png")});
      console.log(await section.innerText());
      throw new Error(`Failed browser check: ${name}`);
    }
  };

  await test("loading shows no seeded answers",async () => {
    getMode = "slow";
    waitGet = new Promise(resolve => {releaseGet=resolve;});
    const requested = page.waitForRequest(r => r.url().endsWith("/api/docs/feedback"));
    await page.goto(origin+"/docs");
    await requested;
    try {assert.equal(await section.locator("article").count(),0);}
    finally {releaseGet();await settled();}
  });
  await test("failed load shows no seeded answers",async () => {
    await load("error");
    assert.equal(await section.locator("article").count(),0);
    if (!baseline) await section.getByRole("alert").filter({hasText:"Feedback is unavailable."}).waitFor();
  });
  await test("network failure preserves a submission draft",async () => {
    await load("empty");await fill();postMode="network";
    await submit.click();
    await page.waitForFunction(() => !document.querySelector('#community button[type="submit"]').disabled);
    await settled();
    assert.equal(await message.inputValue(),draft);
    assert.equal(await form.getByLabel("Email",{exact:true}).inputValue(),"draft@example.test");
    assert.equal(await section.locator("article").count(),0);
  });
  if (!baseline) {
    for (const mode of ["404","405","400","401","403","503","malformed","html","preview","honeypot"]) {
      await test(`unconfirmed ${mode} response preserves all fields`,async () => {
        await load("approved");await fill();postMode=mode;
        const before = requests.filter(m => m === "POST").length;
        await submit.click();
        await form.getByRole("alert").waitFor();
        assert.equal(await message.inputValue(),draft);
        assert.equal(await form.getByLabel("Name",{exact:true}).inputValue(),"Draft reader");
        assert.equal(await form.getByLabel("Email",{exact:true}).inputValue(),"draft@example.test");
        assert.equal(await form.getByRole("combobox",{name:/^Type/}).inputValue(),"comment");
        assert.equal(await form.getByRole("combobox",{name:/^Topic/}).inputValue(),"Governance");
        assert.equal(await section.locator("article").count(),1);
        assert.doesNotMatch(await section.innerText(),/Submitted\.|preview mode|private_.*error/i);
        assert.equal(requests.filter(m => m === "POST").length,before+1);
      });
    }
    await test("empty, unavailable and malformed lists have distinct states",async () => {
      await load("empty");await section.getByText("No published feedback yet.",{exact:true}).waitFor();
      for (const mode of ["unconfigured","malformed"]) {
        await load(mode);
        await section.getByRole("alert").filter({hasText:"Feedback is unavailable."}).waitFor();
        assert.equal(await section.locator("article").count(),0);
      }
      getMode="approved";
      await section.getByRole("button",{name:"Reload feedback"}).click();
      await section.getByText(question.message,{exact:true}).waitFor();
    });
    await test("a failed network read stays unavailable",async () => {
      getMode="network";await page.goto(origin+"/docs");
      await section.getByRole("alert").filter({hasText:"Feedback is unavailable."}).waitFor();
      assert.equal(await section.locator("article").count(),0);
    });
    await test("confirmed submission clears only the submitted draft and stays out of the public list",async () => {
      await load("empty");await fill();postMode="success";
      await submit.click();
      await form.getByRole("status").filter({hasText:"Submitted. Pending review."}).waitFor();
      assert.equal(await message.inputValue(),"");
      assert.equal(await form.getByLabel("Name",{exact:true}).inputValue(),"");
      assert.equal(await form.getByLabel("Email",{exact:true}).inputValue(),"");
      assert.equal(await section.locator("article").count(),0);
    });
    await test("in-flight submissions lock editing and reject duplicate sends",async () => {
      await load("empty");await fill();postMode="slow";
      waitPost=new Promise(resolve => {releasePost=resolve;});
      const before=requests.filter(m => m === "POST").length;
      const sent=page.waitForRequest(r => r.url().endsWith("/api/docs/feedback") && r.method() === "POST");
      await submit.click();await sent;
      try {
        assert.ok(await message.isDisabled());
        assert.ok(await form.getByLabel("Name",{exact:true}).isDisabled());
        await form.evaluate(node => node.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));
        await settled();
        assert.equal(requests.filter(m => m === "POST").length,before+1);
      } finally {releasePost();}
      await form.getByRole("status").waitFor();
      assert.ok(await message.isEnabled());
    });
    await test("a late list response cannot replace a submission confirmation",async () => {
      getMode="slow";postMode="success";
      waitGet=new Promise(resolve => {releaseGet=resolve;});
      const requested=page.waitForRequest(r => r.url().endsWith("/api/docs/feedback") && r.method() === "GET");
      await page.goto(origin+"/docs");await requested;await fill();
      await submit.click();await form.getByRole("status").waitFor();
      releaseGet();
      await section.getByText("No published feedback yet.",{exact:true}).waitFor();
      assert.equal(await section.locator("article").count(),0);
      assert.equal(await form.getByRole("status").innerText(),"Submitted. Pending review.");
    });
    await test("invalid drafts do not generate a request",async () => {
      await load("empty");await message.fill("Short");
      const before=requests.filter(m => m === "POST").length;
      await submit.click();await form.getByRole("alert").waitFor();
      assert.equal(requests.filter(m => m === "POST").length,before);
      assert.equal(await message.inputValue(),"Short");
    });
    await test("desktop and mobile error states fit without overflow",async () => {
      await load("error");await fill();postMode="503";await submit.click();await form.getByRole("alert").waitFor();
      for (const [name,width,height] of [["desktop",1280,900],["mobile",390,844]]) {
        await page.setViewportSize({width,height});
        await section.scrollIntoViewIfNeeded();
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        assert.ok(await form.evaluate(node => [...node.querySelectorAll("input,select,textarea")].every(control => {
          const bounds=control.getBoundingClientRect(), parent=control.closest("label").getBoundingClientRect();
          return !bounds.width || (bounds.left >= parent.left-1 && bounds.right <= parent.right+1);
        })));
        await section.screenshot({path:join(output,name+".png")});
      }
      assert.deepEqual(errors,[]);
    });
    await test("long stored content wraps on desktop and mobile",async () => {
      const original=question.message;
      question.message="x".repeat(1200);
      try {
        await load("approved");
        for (const [name,width,height] of [["desktop",1280,900],["mobile",390,844]]) {
          await page.setViewportSize({width,height});await section.locator("article").scrollIntoViewIfNeeded();
          assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
          await page.screenshot({path:join(output,name+"-long.png")});
        }
      } finally {question.message=original;}
    });
  }
});
const report={baseline,passed:results.filter(r=>r.passed).length,total:results.length,results};
await writeFile(join(verification,baseline ? "docs-feedback-ui-before.json" : "docs-feedback-ui-final.json"),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
if (report.passed !== report.total) process.exitCode=1;
