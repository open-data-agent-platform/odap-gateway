// Run after a local static build. All page requests terminate in this process.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve, sep } from "node:path";

const { chromium } = createRequire(import.meta.url)(process.env.ODAP_PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({ executablePath: process.env.ODAP_BROWSER_EXECUTABLE, headless: true,
  args: ["--disable-background-networking"] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 }, serviceWorkers: "block" });
  const root = resolve("out"), images = resolve("artifacts/review-browser");
  await mkdir(images, { recursive: true });
  const definitionJson = JSON.stringify({ filters: { year: { column: "order_year", type: "INT64" } },
    measure: { aggregate: "SUM", column: "net_amount" }, metricId: "net_revenue", profile: "odap.bigquery-metric.v1",
    sourceRevision: "orders_v3", table: { project: "demo-project", dataset: "analytics", name: "orders" }, target: "orders", tenantId: "demo" });
  const definitionDigest = "sha256:" + createHash("sha256").update(definitionJson).digest("hex");
  const requests = [], posts = [], errors = [], validated = new Map(), approved = new Map(), releases = new Map();
  const withdrawals = new Map(), withdrawnAt = "2026-11-05T10:00:00.123Z";
  let staleWithdrawalRead = false;
  const retirements = new Map(), retiredAt = "2026-11-05T12:00:00.123Z";
  let staleRetirementRead = false;
  let catalogChanged = false;
  let staleReleaseRead = false;
  page.on("pageerror", error => errors.push(error.message));
  let resume;
  const slow = new Promise(resolve => { resume = resolve; });
  let finishPreview;
  const delayedPreview = new Promise(resolve => { finishPreview = resolve; });
  let finishOwnerReview;
  const delayedOwnerReview = new Promise(resolve => { finishOwnerReview = resolve; });
  // Deliver even a superseded review response to exercise the UI's stale-result guard.
  await page.addInitScript(() => {
    const get = window.fetch;
    window.fetch = (url, options) => get(url, String(url).endsWith("/human-grant-reviews") ? { ...options, signal: undefined } : options);
  });
  const submissions = [];
  const grantAttempts = [];
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin !== "https://gateway.test") return route.abort();
    if (url.pathname.startsWith("/api/control/")) {
      const [, , , tenantId, kind, revisionId] = url.pathname.split("/");
      requests.push(route.request().method());
      if (route.request().method() === "POST") {
        const input = route.request().postDataJSON();
        posts.push({ path: url.pathname, ...input });
        if (kind === "human-grant-reviews") {
          if (input.policyRevision === "obsolete") return route.fulfill({ status: 404, json: { ok: false, code: "grant_review_unavailable" } });
          if (input.reviewedAction.parameters.year === 2025) await delayedOwnerReview;
          const { reviewedAction: a, ...ids } = input;
          const actionDigest = "sha256:" + createHash("sha256").update(JSON.stringify({ metricId: a.metricId,
            parameters: a.parameters, profile: a.profile, target: a.target })).digest("hex");
          return route.fulfill({ json: { ok: true, review: { tenantId, ...ids, state: "matched", reviewedBy: "google:owner", actionDigest } } });
        }
        if (kind === "human-grants") {
          grantAttempts.push(input);
          if (grantAttempts.length === 1) return route.abort("failed");
          if (input.policyRevision !== "p1") return route.fulfill({ status: 409, json: { ok: false, code: "human_grant_not_recorded" } });
          const { reviewedAction: a, ...terms } = input, now = Date.now();
          const actionDigest = "sha256:" + createHash("sha256").update(JSON.stringify({ metricId: a.metricId,
            parameters: a.parameters, profile: a.profile, target: a.target })).digest("hex");
          return route.fulfill({ json: { ok: true, grant: { ...terms, tenantId, grantedBy: "google:owner", actionDigest,
            grantedAt: new Date(now).toISOString(), expiresAt: new Date(now + 600000).toISOString() } } });
        }
        if (kind === "contract-requests") {
          submissions.push(input);
          if (submissions.length === 1) return route.abort("failed");
          if (submissions.length !== 3) return route.fulfill({ status: 409, json: { ok: false, code: "contract_request_not_recorded" } });
          const a = input.action;
          const actionDigest = "sha256:" + createHash("sha256").update(JSON.stringify({ metricId: a.metricId,
            parameters: a.parameters, profile: a.profile, target: a.target })).digest("hex");
          return route.fulfill({ status: 200, json: { ok: true, request: { requestId: input.requestId, releaseId: input.releaseId,
            requestedAgentId: input.requestedAgentId, state: "proposed", actionDigest, requestedAt: "2026-11-06T00:00:00.000Z" } } });
        }
        if (kind === "metric-previews") {
          if (retirements.has(input.releaseId)) return route.fulfill({ status: 404, json: { ok: false, code: "metric_preview_unavailable" } });
          if (input.action.parameters.year === 2025) await delayedPreview;
          return route.fulfill({ json: { ok: true, preview: { releaseId: input.releaseId, state: "compiled", parameterCount: 1 } } });
        }
        if (kind === "retirements") {
          const id = input.releaseId;
          const replay = retirements.has(id);
          if (!replay) retirements.set(id, { reason: input.reason, at: retiredAt });
          if (id === "release-retire-lost") return route.abort("failed");
          staleRetirementRead = id === "release-retire-new";
          const at = retirements.get(id).at;
          return route.fulfill({ status: replay ? 200 : 201, headers: { Location: "/api/control/demo/release/" + id },
            json: { ok: true, effect: "future_dispatch_claims_only", retirement: at === null ? { status: "legacy_retired" }
              : { status: replay ? "already_retired" : "retired", retiredAt: at } } });
        }
        if (kind === "withdrawals") {
          const id = input.revisionId;
          if (releases.has(id)) return route.fulfill({ status: 409, json: { ok: false, code: "already_promoted", releaseId: releases.get(id) } });
          const existing = withdrawals.has(id);
          if (!existing) withdrawals.set(id, input.reason);
          if (id === "withdraw-lost") return route.abort("failed");
          staleWithdrawalRead = id === "withdraw-new";
          return route.fulfill({ status: existing ? 200 : 201, headers: { Location: "/api/control/demo/review/" + id },
            json: { ok: true, withdrawal: { status: existing ? "already_withdrawn" : "withdrawn", withdrawnAt } } });
        }
        if (kind === "promotions") {
          if (catalogChanged) return route.fulfill({ status: 409, json: { ok: false, code: "promotion_not_recorded" } });
          const id = input.revisionId === "competing" ? "other-release" : input.releaseId;
          releases.set(input.revisionId, id);
          staleReleaseRead = input.revisionId === "owned";
          if (input.revisionId !== "owned") return route.abort("failed");
          return route.fulfill({ status: 201, headers: { Location: "/api/control/demo/release/" + id },
            json: { ok: true, promotion: { releaseId: id } } });
        }
        if (kind === "approvals") {
          approved.set(input.revisionId, input.revisionId === "competing" ? "other-decision" : input.approvalId);
          if (["lost", "competing"].includes(input.revisionId)) return route.abort("failed");
          return route.fulfill({ status: 201, headers: { Location: "/api/control/demo/review/" + input.revisionId },
            json: { ok: true, approval: { revisionId: input.revisionId, approvalId: input.approvalId } } });
        }
        validated.set(input.revisionId, input.evidenceRef);
        if (input.revisionId === "lost") return route.abort("failed");
        return route.fulfill({ status: 201, headers: { Location: "/api/control/demo/review/" + input.revisionId },
          json: { ok: true, validation: { revisionId: input.revisionId, definitionDigest } } });
      }
      if (revisionId === "guest") return route.fulfill({ status: 401, json: { ok: false, code: "unauthenticated" } });
      if (revisionId === "slow") await slow;
      const common = { tenantId, revisionId, definitionDigest };
      if (kind === "approval-basis") return route.fulfill({ json: { ok: true, basis: { ...common, evidenceRef: validated.get(revisionId) } } });
      const hideRelease = kind === "review" && revisionId === "owned" && staleReleaseRead;
      if (hideRelease) staleReleaseRead = false;
      const hideWithdrawal = kind === "review" && revisionId === "withdraw-new" && staleWithdrawalRead;
      if (hideWithdrawal) staleWithdrawalRead = false;
      const hideRetirement = kind === "review" && revisionId === "retire-new" && staleRetirementRead;
      if (hideRetirement) staleRetirementRead = false;
      const retired = !hideRetirement && retirements.get(releases.get(revisionId));
      const withdrawn = !hideWithdrawal && withdrawals.has(revisionId);
      const ownsPending = !withdrawn && approved.has(revisionId) && (hideRelease || !releases.has(revisionId)) && revisionId !== "another-owner";
      return route.fulfill({ json: kind === "review"
        ? { ok: true, review: { ...common, state: retired ? "retired" : !hideRelease && releases.has(revisionId) ? "published" :
          withdrawn ? "withdrawn" : approved.has(revisionId) ? "approved" : validated.has(revisionId) ? "validated" : "candidate",
          canRequestPromotion: ownsPending, canWithdrawApproval: ownsPending, withdrawnAt: withdrawn ? withdrawnAt : null,
          canRetireRelease: !retired && releases.has(revisionId) && revisionId !== "retire-peer", retiredAt: retired?.at ?? null,
          releaseId: hideRelease ? null : releases.get(revisionId),
          canReviewApproval: validated.has(revisionId) && !approved.has(revisionId), approvalId: approved.get(revisionId),
          canRecordValidation: revisionId !== "rev-7" && !validated.has(revisionId), metricId: "net_revenue", sourceRevision: "orders_v3" } }
        : { ok: true, revision: { ...common, definitionJson } } });
    }
    if (url.pathname === "/api/auth/session") return route.fulfill({ json: { authenticated: true,
      user: { provider: "google", name: "Reviewer", email: "reviewer@example.test", role: "member" } } });
    const path = resolve(root, "." + (["/semantic-review", "/login"].includes(url.pathname) ? url.pathname + ".html" : url.pathname));
    if (!path.startsWith(root + sep)) return route.abort();
    try { return await route.fulfill({ path }); }
    catch { return route.fulfill({ status: 404, body: "" }); }
  });
  await page.goto("https://gateway.test/semantic-review");
  const tenant = page.getByLabel("Tenant ID"), revision = page.getByLabel("Revision ID");
  const inspect = page.getByRole("button", { name: "Inspect" }), source = page.locator("article code");
  await tenant.fill("demo");
  await revision.fill("rev-7");
  await inspect.click();
  await source.waitFor();
  assert.equal(await source.textContent(), definitionJson);
  assert.equal(await page.getByText(definitionDigest).count(), 1);
  const record = page.getByRole("button", { name: "Record evidence" });
  assert.equal(await record.count(), 0);
  assert.ok(requests.every(method => method === "GET"));
  assert.equal(await page.getByRole("form", { name: "Metric preview" }).count(), 0);
  await revision.fill("owned");
  await inspect.click();
  await record.waitFor();
  assert.ok(await record.isDisabled());
  await page.getByLabel("Evidence reference", { exact: true }).fill("fixture:checked");
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 850 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "page overflows at " + width);
    await page.screenshot({ path: resolve(images, "validation-" + width + ".png"), fullPage: true });
  }
  await page.getByRole("form", { name: "Validation evidence" }).evaluate(form => {
    form.requestSubmit();
    form.requestSubmit();
  });
  await page.getByText("Validation evidence recorded.", { exact: true }).waitFor();
  await page.getByLabel("Review state: validated").waitFor();
  assert.equal(await record.count(), 0);
  await revision.fill("lost");
  await inspect.click();
  await page.getByLabel("Evidence reference", { exact: true }).fill("fixture:ambiguous");
  await record.click();
  await page.getByText("The outcome could not be confirmed.", { exact: false }).waitFor();
  assert.equal(await record.count(), 0);
  await inspect.click();
  await page.getByLabel("Review state: validated").waitFor();
  assert.equal(await record.count(), 0);
  assert.deepEqual(posts, [["owned", "fixture:checked"], ["lost", "fixture:ambiguous"]].map(([revisionId, evidenceRef]) => ({
    path: "/api/control/demo/validations", revisionId, reviewedDigest: definitionDigest, evidenceRef
  })));
  const approvalButton = page.getByRole("button", { name: "Approve definition" });
  await page.getByText("fixture:ambiguous", { exact: true }).waitFor();
  await approvalButton.click();
  await page.getByText("Attempted approval ID:", { exact: false }).waitFor();
  assert.ok((await page.getByRole("status").allTextContents()).join(" ").includes(approved.get("lost")));
  await inspect.click();
  await page.getByText(approved.get("lost"), { exact: true }).waitFor();
  await page.getByText("The stored approval matches your earlier attempt.", { exact: true }).waitFor();
  assert.equal(await approvalButton.count(), 0);
  await revision.fill("owned");
  await inspect.click();
  const approvalForm = page.getByRole("form", { name: "Semantic approval" });
  await approvalForm.getByText("fixture:checked", { exact: true }).waitFor();
  assert.equal(await approvalForm.getByRole("link").count(), 0);
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 850 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: resolve(images, "approval-" + width + ".png"), fullPage: true });
  }
  await approvalForm.evaluate(form => { form.requestSubmit(); form.requestSubmit(); });
  await page.getByText("Semantic approval recorded.", { exact: true }).waitFor();
  await page.getByLabel("Review state: approved").waitFor();
  assert.equal(await approvalButton.count(), 0);
  for (const [i, id] of ["lost", "owned"].entries()) {
    assert.match(approved.get(id), /^[a-f0-9-]{36}$/);
    assert.deepEqual(posts[i + 2], { path: "/api/control/demo/approvals", revisionId: id, reviewedDigest: definitionDigest,
      evidenceRef: validated.get(id), approvalId: approved.get(id) });
  }
  validated.set("competing", "fixture:third");
  await revision.fill("competing");
  await inspect.click();
  await approvalButton.click();
  await page.getByText("Attempted approval ID:", { exact: false }).waitFor();
  await inspect.click();
  await page.getByText("A different approval is recorded for this revision.", { exact: false }).waitFor();
  await page.getByText("other-decision", { exact: true }).waitFor();
  assert.equal(await approvalButton.count(), 0);
  const publish = page.getByRole("button", { name: "Publish release" });
  assert.equal(posts.filter(p => p.path.endsWith("/promotions")).length, 0);
  approved.set("another-owner", "other-owner-approval");
  await revision.fill("another-owner");
  await inspect.click();
  await page.getByLabel("Review state: approved").waitFor();
  assert.equal(await publish.count(), 0);
  assert.equal(await page.getByRole("form", { name: "Approval withdrawal" }).count(), 0);
  await revision.fill("owned");
  await inspect.click();
  catalogChanged = true;
  await publish.click();
  await page.getByText("Publication was refused.", { exact: false }).waitFor();
  assert.equal(releases.size, 0);
  assert.equal(await publish.count(), 0);
  await inspect.click();
  await page.getByLabel("Review state: approved").waitFor();
  catalogChanged = false;
  const publishForm = page.getByRole("form", { name: "Semantic publication" });
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 850 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: resolve(images, "promotion-" + width + ".png"), fullPage: true });
  }
  await publishForm.evaluate(form => { form.requestSubmit(); form.requestSubmit(); });
  await page.getByText("Publication was confirmed, but", { exact: false }).waitFor();
  assert.equal(await publish.count(), 0);
  assert.ok((await page.getByRole("status").allTextContents()).join(" ").includes(releases.get("owned")));
  await inspect.click();
  await page.getByLabel("Review state: published").waitFor();
  assert.equal(await page.getByRole("link", { name: releases.get("owned"), exact: true }).getAttribute("href"),
    "/api/control/demo/release/" + releases.get("owned"));
  assert.equal(await publish.count(), 0);
  for (const id of ["lost", "competing"]) {
    await revision.fill(id);
    await inspect.click();
    await publish.click();
    await page.getByText("Attempted release ID:", { exact: false }).waitFor();
    const submitted = posts.at(-1);
    assert.deepEqual(submitted, { path: "/api/control/demo/promotions", revisionId: id, approvalId: approved.get(id), releaseId: submitted.releaseId });
    assert.match(submitted.releaseId, /^[a-f0-9-]{36}$/);
    await inspect.click();
    await page.getByText(id === "lost" ? "The stored release matches your earlier attempt." :
      "A different release is recorded for this revision.", { exact: false }).waitFor();
    await page.getByRole("link", { name: releases.get(id), exact: true }).waitFor();
    assert.equal(await publish.count(), 0);
  }
  const withdrawalForm = page.getByRole("form", { name: "Approval withdrawal" });
  const withdraw = withdrawalForm.getByRole("button", { name: "Withdraw approval" });
  for (const id of ["withdraw-new", "withdraw-replay", "withdraw-race", "withdraw-lost"]) {
    approved.set(id, "approval-" + id);
    await revision.fill(id);
    await inspect.click();
    await withdrawalForm.waitFor();
    assert.ok(await withdraw.isDisabled());
    const why = "private:" + id;
    await withdrawalForm.getByRole("textbox").fill(why);
    if (id === "withdraw-replay") withdrawals.set(id, "private:original");
    if (id === "withdraw-race") releases.set(id, "winning-release");
    if (id === "withdraw-new") {
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 850 });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await page.screenshot({ path: resolve(images, "withdrawal-" + width + ".png"), fullPage: true });
      }
    }
    await withdrawalForm.evaluate(form => { form.requestSubmit(); form.requestSubmit(); });
    if (id === "withdraw-new") {
      await page.getByText("The review does not yet match", { exact: false }).waitFor();
      await page.getByText("Approval withdrawn.", { exact: false }).waitFor();
      assert.equal(await publish.count(), 0);
      assert.equal(await withdrawalForm.count(), 0);
      await inspect.click();
    } else if (id === "withdraw-lost") {
      await page.getByText("The outcome could not be confirmed.", { exact: false }).waitFor();
      await inspect.click();
    } else if (id === "withdraw-replay") {
      await page.getByText("The original reason was retained.", { exact: false }).waitFor();
      assert.equal(withdrawals.get(id), "private:original");
    } else {
      await page.getByText("This request did not withdraw the approval", { exact: false }).waitFor();
      await page.getByRole("link", { name: "winning-release", exact: true }).waitFor();
    }
    await page.getByLabel("Review state: " + (id === "withdraw-race" ? "published" : "withdrawn")).waitFor();
    assert.equal(await withdrawalForm.count(), 0);
    assert.equal(await publish.count(), 0);
    assert.deepEqual(posts.at(-1), { path: "/api/control/demo/withdrawals", approvalId: approved.get(id), revisionId: id, reason: why });
    assert.ok(!(await page.locator("body").innerText()).includes(why));
  }
  assert.ok(posts.every(p => !p.path.endsWith("/retirements")));
  const retireForm = page.getByRole("form", { name: "Release retirement" });
  for (const id of ["retire-peer", "retire-new", "retire-replay", "retire-legacy", "retire-lost"]) {
    const releaseId = "release-" + id, why = "private:" + id;
    approved.set(id, "decision-" + id);
    releases.set(id, releaseId);
    await revision.fill(id);
    await inspect.click();
    await page.getByLabel("Review state: published").waitFor();
    if (id === "retire-peer") {
      assert.equal(await page.getByRole("form", { name: "Owner grant review" }).count(), 0);
      assert.equal(await retireForm.count(), 0);
      continue;
    }
    assert.ok(await retireForm.getByRole("button").isDisabled());
    await retireForm.getByText("Jobs already handed off are not cancelled.", { exact: false }).waitFor();
    await retireForm.getByLabel("Retirement reason").fill(why);
    if (id === "retire-new") {
      for (const width of [390, 1280]) {
        await page.setViewportSize({ width, height: 850 });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await page.screenshot({ path: resolve(images, "retirement-" + width + ".png"), fullPage: true });
      }
    }
    if (id === "retire-legacy" || id === "retire-replay") retirements.set(releaseId, { reason: "original", at: id === "retire-legacy" ? null : retiredAt });
    await retireForm.evaluate(form => { form.requestSubmit(); form.requestSubmit(); });
    if (id === "retire-new" || id === "retire-lost") {
      await page.getByText(id === "retire-new" ? "Retirement confirmed. The review" : "The outcome could not be confirmed.", { exact: false }).waitFor();
      assert.equal(await retireForm.count(), 0);
      await inspect.click();
    } else {
      await page.getByText(id === "retire-legacy" ? "Already retired. No retirement time" : "Already retired. The original reason", { exact: false }).waitFor();
      assert.equal(retirements.get(releaseId).reason, "original");
    }
    await page.getByLabel("Review state: retired").waitFor();
    assert.equal(await page.locator("time").count(), id === "retire-legacy" ? 0 : 1);
    assert.equal(await retireForm.count(), 0);
    assert.deepEqual(posts.at(-1), { path: "/api/control/demo/retirements", releaseId, reason: why });
    assert.ok(!(await page.locator("body").innerText()).includes(why));
  }
  assert.equal(await page.getByRole("form", { name: "Metric preview" }).count(), 0);
  const previewId = releases.get("retire-peer");
  await revision.fill("retire-peer");
  await inspect.click();
  const form = page.getByRole("form", { name: "Metric preview" });
  const year = form.getByRole("spinbutton"), check = form.getByRole("button", { name: "Check compilation" });
  const compiled = form.getByText("Compiled. No query was run", { exact: false });
  await form.waitFor();
  assert.ok(await check.isDisabled());
  await year.fill("2026");
  await check.click();
  await compiled.waitFor();
  assert.deepEqual(posts.at(-1), { path: "/api/control/demo/metric-previews", releaseId: previewId,
    action: { profile: "odap.metric-read.v1", target: "orders", metricId: "net_revenue", parameters: { year: 2026 } } });
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 850 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await form.screenshot({ path: resolve(images, "metric-preview-" + width + ".png") });
  }
  assert.equal(submissions.length, 0);
  const requestForm = page.getByRole("form", { name: "Contract request" });
  const agent = requestForm.getByLabel("Requested agent ID");
  const propose = requestForm.getByRole("button", { name: "Submit request" });
  assert.ok(await propose.isDisabled());
  await agent.fill("reporter");
  await requestForm.evaluate(f => { f.requestSubmit(); f.requestSubmit(); });
  await requestForm.getByText("No acknowledgement.", { exact: false }).waitFor();
  assert.equal(submissions.length, 1);
  assert.match(submissions[0].requestId, /^[a-f0-9-]{36}$/);
  assert.deepEqual(submissions[0], { requestId: submissions[0].requestId, releaseId: previewId, requestedAgentId: "reporter",
    action: { profile: "odap.metric-read.v1", target: "orders", metricId: "net_revenue", parameters: { year: 2026 } } });
  await year.fill("2027");
  const retry = requestForm.getByRole("button", { name: "Retry original request" });
  await retry.click();
  await requestForm.getByText("Retry refused.", { exact: false }).waitFor();
  await retry.click();
  await requestForm.getByText("Proposal recorded.", { exact: false }).waitFor();
  assert.deepEqual(submissions.slice(1), [submissions[0], submissions[0]]);
  await year.fill("2026");
  assert.ok(await propose.isDisabled());
  await agent.fill("reporter-v2");
  await year.fill("2027");
  await propose.click();
  await requestForm.getByText("Submission refused.", { exact: false }).waitFor();
  assert.notEqual(submissions[3].requestId, submissions[0].requestId);
  assert.equal(submissions[3].requestedAgentId, "reporter-v2");
  assert.equal(submissions[3].action.parameters.year, 2027);
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 850 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await requestForm.screenshot({ path: resolve(images, "contract-request-" + width + ".png") });
  }
  await year.fill("2025");
  assert.equal(await compiled.count(), 0);
  const sent = page.waitForRequest(req => req.url().endsWith("/metric-previews"));
  await check.click();
  await sent;
  await year.fill("2024");
  assert.equal(await form.getByRole("status").innerText(), "");
  retirements.set(previewId, { at: retiredAt });
  await check.click();
  const refused = form.getByText("This release is no longer available", { exact: false });
  await refused.waitFor();
  finishPreview();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await refused.waitFor();
  assert.equal(await compiled.count(), 0);
  await inspect.click();
  await page.getByLabel("Review state: retired").waitFor();
  assert.equal(await form.count(), 0);
  const ownerForm = page.getByRole("form", { name: "Owner grant review" });
  assert.equal(await ownerForm.count(), 0);
  approved.set("owner-review", "decision-review");
  releases.set("owner-review", "release-review");
  await revision.fill("owner-review");
  await inspect.click();
  await ownerForm.waitFor();
  const match = ownerForm.getByRole("button", { name: "Check request match" });
  const matched = ownerForm.getByText("Request and policy matched at review time.", { exact: false });
  await year.fill("2026");
  const fields = [["Requester ID", "google:analyst"], ["Request ID", "req-1"], ["Requested agent ID", "reporter"], ["Policy revision", "p1"]];
  for (const [label, value] of fields) {
    assert.ok(await match.isDisabled());
    await ownerForm.getByLabel(label, { exact: true }).fill(value);
  }
  await match.click();
  await matched.waitFor();
  assert.deepEqual(posts.at(-1), { path: "/api/control/demo/human-grant-reviews", releaseId: "release-review",
    requesterId: "google:analyst", requestId: "req-1", requestedAgentId: "reporter", policyRevision: "p1",
    reviewedAction: { profile: "odap.metric-read.v1", target: "orders", metricId: "net_revenue", parameters: { year: 2026 } } });
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 850 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await ownerForm.screenshot({ path: resolve(images, "owner-review-" + width + ".png") });
  }
  for (const [label, value] of fields) {
    const input = ownerForm.getByLabel(label, { exact: true });
    await input.fill(value + "-changed");
    assert.equal(await matched.count(), 0);
    await input.fill(value);
    await match.click();
    await matched.waitFor();
  }
  await year.fill("2025");
  assert.equal(await matched.count(), 0);
  const reviewSent = page.waitForRequest(r => r.url().endsWith("/human-grant-reviews"));
  await match.click();
  await reviewSent;
  await year.fill("2024");
  await ownerForm.getByLabel("Policy revision").fill("obsolete");
  await match.click();
  const noMatch = ownerForm.getByText("No current match", { exact: false });
  await noMatch.waitFor();
  const oldReviewFinished = page.waitForEvent("requestfinished", { predicate: r => r.url().endsWith("/human-grant-reviews") && r.postDataJSON().reviewedAction.parameters.year === 2025 });
  finishOwnerReview();
  await oldReviewFinished;
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  await noMatch.waitFor();
  assert.equal(await matched.count(), 0);
  const decide = page.getByRole("region", { name: "Owner grant decision" });
  const grant = decide.getByRole("button", { name: "Record owner grant" });
  assert.equal(await decide.count(), 0);
  await ownerForm.getByLabel("Policy revision").fill("p1");
  await match.click();
  await matched.waitFor();
  await decide.getByRole("button", { name: "Close without granting" }).click();
  assert.equal(await decide.count(), 0);
  assert.equal(grantAttempts.length, 0);
  await match.click();
  await grant.evaluate(button => { button.click(); button.click(); });
  await decide.getByText("No verified acknowledgement.", { exact: false }).waitFor();
  assert.equal(grantAttempts.length, 1);
  // Reinspection does not auto-submit. The same confirmed action must reuse the original ID.
  await match.click();
  await grant.click();
  await decide.getByText("Grant recorded:", { exact: false }).waitFor();
  assert.equal(grantAttempts.length, 2);
  assert.deepEqual(grantAttempts[0], grantAttempts[1]);
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 850 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await decide.screenshot({ path: resolve(images, "owner-decision-" + width + ".png") });
  }
  await ownerForm.getByLabel("Policy revision").fill("p2");
  assert.equal(await decide.count(), 0);
  await match.click();
  await grant.click();
  await decide.getByText("Grant not confirmed on this attempt.", { exact: false }).waitFor();
  assert.notEqual(grantAttempts[2].grantId, grantAttempts[0].grantId);
  await revision.fill("slow");
  assert.equal(await ownerForm.count(), 0);
  assert.equal(await source.count(), 0);
  const waiting = page.waitForRequest(req => req.url().endsWith("/definition/slow"));
  await inspect.click();
  await waiting;
  await revision.fill("guest");
  await inspect.click();
  await page.getByText("Sign in to inspect a revision.", { exact: false }).first().waitFor();
  const finished = page.waitForEvent("requestfinished", { predicate: req => req.url().endsWith("/definition/slow"), timeout: 1000 })
    .catch(() => {}); // Browsers may cancel the transport instead of delivering a late response.
  resume();
  await finished;
  assert.equal(await source.count(), 0);
  const login = await page.getByRole("status").getByRole("link", { name: "Sign in" }).getAttribute("href");
  assert.equal(login, "/login?returnTo=%2Fsemantic-review");
  await page.goto("https://gateway.test" + login);
  await page.locator('a[href="/api/auth/start/google?returnTo=%2Fsemantic-review"]').waitFor();
  assert.equal(await page.locator('a[href="/api/auth/start/github?returnTo=%2Fsemantic-review"]').count(), 1);
  assert.equal(requests.filter(method => method !== "GET").length, 38);
  assert.equal(grantAttempts.length, 3);
  assert.deepEqual(errors, []);
  console.log("Browser review passed: lifecycle, typed compilation preview, owner-only match, superseded responses, retirement and both widths.");
} finally {
  await browser.close();
}
