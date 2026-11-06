import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { origin, withOfflinePage } from "./offline-ui.mjs";

const shots = fileURLToPath(new URL("../artifacts/request-history-ui", import.meta.url));
await mkdir(shots, { recursive: true });
await withOfflinePage(async page => {
  const calls = [], writes = [], revocations = [], errors = [];
  const grantedAt = new Date(), expiresAt = new Date(+grantedAt + 600000).toISOString();
  const terms = { purpose: "odap.gateway.contract-delegation-proof.v1", tenantId: "demo", requesterId: "demo:requester",
    requestId: "current", grantId: "recent-grant", agentId: "reporter", keyId: "demo-key", releaseId: "revenue-v1",
    actionDigest: "sha256:" + "a".repeat(64), delegationId: "demo-delegation", expiresAt, audience: "demo-gateway",
    policyRevision: "p1", projectId: "synthetic-project", location: "US" };
  const challenge = JSON.stringify(terms, Object.keys(terms).sort());
  page.on("pageerror", error => errors.push(error.message));
  let denied = false;
  let historyReads = 0;
  const revokedAt = "2020-01-01T12:16:00.000Z";
  let storedRevocation = null;
  const historyPath = "/api/control/demo/grant-delegation/historical-grant-7";
  const recentHistoryPath = "/api/control/demo/grant-delegation/recent-grant";
  await page.route(origin + "/api/control/**", async route => {
    const req = route.request(), url = new URL(req.url());
    calls.push([req.method(), url.pathname + url.search]);
    if (url.pathname === recentHistoryPath) {
      assert.equal(req.method(), "GET");
      return route.fulfill({ json: { ok: true, object: { tenantId: "demo", grantId: terms.grantId,
        requestId: "current", agentId: "reporter", keyId: terms.keyId, delegationId: terms.delegationId,
        expiresAt, verifiedAt: null, revokedAt: new Date().toISOString() } } });
    }
    if (url.pathname === historyPath) {
      historyReads++;
      assert.equal(req.method(), "GET");
      if (denied) return route.fulfill({ status: 403, json: { ok: false, code: "tenant_access_denied" } });
      return route.fulfill({ json: { ok: true, object: { tenantId: "demo", grantId: "historical-grant-7",
        requestId: "req", agentId: "reporter", keyId: "old-key", delegationId: "old-delegation",
        expiresAt: "2020-01-01T12:10:00.000Z", verifiedAt: "2020-01-01T12:02:00.000Z", revokedAt: storedRevocation } } });
    }
    if (req.method() === "POST" && url.pathname === "/api/control/demo/delegations") {
      if (req.postDataJSON().operation === "revoke") {
        revocations.push(req.postDataJSON());
        if (revocations.length === 1) return route.fulfill({ json: { ok: true, revocation: { revokedAt } } });
        storedRevocation = revokedAt;
        return route.abort("failed");
      }
      writes.push(req.postDataJSON());
      if (writes.length === 1) return route.abort("failed");
      if (writes.length === 2) return route.fulfill({ json: { ok: true, delegation: { delegationId: terms.delegationId, expiresAt, challenge } } });
      return route.fulfill({ status: 409, json: { ok: false, code: "delegation_unavailable" } });
    }
    const [, , , tenantId, , id] = url.pathname.split("/");
    const status = denied ? 403 : id === "missing" ? 404 : id === "login" ? 401 : 200;
    return route.fulfill({ status, json: status === 200 ? { ok: true, object: {
      tenantId, id: id === "swapped" ? "other" : id, recordedState: "proposed", releaseId: "revenue-v1",
      requestedAgentId: "reporter", actionDigest: "sha256:" + "a".repeat(64), requestedAt: "2020-01-01T11:00:00.000Z",
      ...(id === "legacy" ? {} : { grantReference: id === "pending" ? null : id === "current" ?
        { grantId: terms.grantId, grantedAt: grantedAt.toISOString(), expiresAt } : {
        grantId: "historical-grant-7", grantedAt: "2020-01-01T12:00:00.000Z",
        expiresAt: id === "malformed" ? "2099" : "2020-01-01T12:10:00.000Z" } })
    } } : { ok: false, code: { 401: "unauthenticated", 403: "tenant_access_denied", 404: "not_found" }[status] } });
  });
  await page.goto(origin + "/approvals");
  await page.getByRole("link", { name: "Look up my request" }).click();
  const id = page.getByLabel("Request ID"), submit = page.getByRole("button", { name: /^(Inspect request|Refresh)$/ });
  const title = page.getByRole("heading", { name: "Recorded proposal" });
  await page.getByLabel("Tenant ID").fill("demo");
  await id.fill("req");
  await submit.click();
  await title.waitFor();
  await page.getByText("This record confirms submission only.", { exact: false }).waitFor();
  const grant = page.getByText("historical-grant-7", { exact: true });
  await grant.waitFor();
  await page.getByText("Historical record only.", { exact: false }).waitFor();
  const consent = page.getByRole("region", { name: "Requester delegation" });
  const create = consent.getByRole("button", { name: "Consent to delegation" });
  assert.equal(await create.count(), 0);
  const history = page.getByRole("region", { name: "Delegation history" });
  assert.equal(historyReads, 0);
  await history.getByRole("button", { name: "Look up delegation" }).click();
  await history.getByText("old-delegation", { exact: true }).waitFor();
  const revoke = history.getByRole("button", { name: "Revoke delegation", exact: true });
  const confirm = history.getByRole("button", { name: "Confirm revocation" });
  await revoke.click();
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 850 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await history.screenshot({ path: resolve(shots, "confirm-revocation-" + width + ".png") });
  }
  await history.getByRole("button", { name: "Keep delegation" }).click();
  assert.equal(await confirm.count(), 0);
  assert.deepEqual(revocations, []);
  await revoke.click();
  await confirm.evaluate(button => { button.click(); button.click(); });
  await history.getByText("Revocation not verified.", { exact: false }).waitFor();
  assert.equal(revocations.length, 1);
  assert.equal(await revoke.count(), 0);
  await history.getByRole("button", { name: "Look up delegation" }).click();
  await revoke.click();
  await confirm.click();
  await history.getByText(revokedAt, { exact: true }).waitFor();
  await history.getByText("2020-01-01T12:02:00.000Z", { exact: true }).waitFor();
  assert.equal(await revoke.count(), 0);
  assert.deepEqual(revocations, Array(2).fill({ operation: "revoke", delegationId: "old-delegation" }));
  assert.equal(await page.getByLabel("Exact signing challenge").count(), 0);
  const recover = history.getByRole("button", { name: "Look up issued contract" });
  const oldContract = history.getByText("historical-contract-9", { exact: true });
  let historicalReads = 0;
  await page.route(origin + "/api/control/demo/delegation-issuance/old-delegation", route => {
    assert.equal(route.request().method(), "GET");
    historicalReads++;
    if (denied) return route.fulfill({ status: 403, json: { ok: false, code: "tenant_access_denied" } });
    return route.fulfill({ json: { ok: true, object: { tenantId: "demo", requestId: "req", grantId: "historical-grant-7",
      delegationId: "old-delegation", contractId: "historical-contract-9" } } });
  });
  await recover.click();
  await oldContract.waitFor();
  const pastReservation = history.getByRole("region", { name: "Reservation history" });
  const readReservation = pastReservation.getByRole("button", { name: "Look up reservation" });
  await page.route(origin + "/api/control/demo/contract-admission/historical-contract-9", route => {
    assert.equal(route.request().method(), "GET");
    if (denied) return route.fulfill({ status: 403, json: { ok: false, code: "tenant_access_denied" } });
    return route.fulfill({ json: { ok: true, object: { tenantId: "demo", contractId: "historical-contract-9",
      delegationId: "old-delegation", actionDigest: terms.actionDigest, intentId: "previous-intent", budgetId: "analytics", originalMicroUsd: 80 } } });
  });
  await readReservation.click();
  await pastReservation.getByText("previous-intent", { exact: true }).waitFor();
  assert.equal(await history.getByRole("button", { name: "Review budget reservation" }).count(), 0);
  assert.equal(await history.getByRole("button", { name: "Issue Approval Contract" }).count(), 0);
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 850 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: resolve(shots, width + ".png"), fullPage: true });
    await history.screenshot({ path: resolve(shots, "delegation-history-" + width + ".png") });
    await pastReservation.screenshot({ path: resolve(shots, "reservation-history-" + width + ".png") });
  }
  denied = true;
  await readReservation.click();
  await pastReservation.getByRole("status").filter({ hasText: "do not have access" }).waitFor();
  assert.equal(await pastReservation.getByText("previous-intent", { exact: true }).count(), 0);
  await recover.click();
  await history.getByRole("status").filter({ hasText: "do not have access" }).waitFor();
  assert.equal(await oldContract.count(), 0);
  assert.equal(historicalReads, 2);
  await history.getByRole("button", { name: "Refresh delegation history" }).click();
  await history.getByRole("status").filter({ hasText: "do not have access" }).waitFor();
  assert.equal(await history.getByText("old-delegation", { exact: true }).count(), 0);
  assert.equal(writes.length, 0);
  await submit.click();
  await page.getByRole("status").filter({ hasText: "do not have access" }).waitFor();
  assert.equal(await title.count(), 0);
  assert.equal(await grant.count(), 0);
  denied = false;
  for (const [value, message] of [["pending", "No owner grant was recorded at lookup time."], ["legacy", "Grant history is unavailable."]]) {
    await id.fill(value);
    await submit.click();
    await page.getByText(message, { exact: true }).waitFor();
    assert.equal(await grant.count(), 0);
    assert.equal(await consent.count(), 0);
  }
  await id.fill("current");
  await submit.click();
  await create.waitFor();
  assert.ok(await create.isDisabled());
  const key = consent.getByLabel("Enrolled key ID");
  await key.fill("demo-key");
  assert.equal(writes.length, 0);
  await create.evaluate(button => { button.click(); button.click(); });
  await consent.getByText("No verified acknowledgement.", { exact: false }).waitFor();
  assert.ok(await key.isDisabled());
  assert.equal(writes.length, 1);
  await consent.getByRole("button", { name: "Retry same delegation" }).click();
  await consent.getByText("Delegation recorded:", { exact: false }).waitFor();
  await consent.getByText("Agent signing challenge", { exact: true }).click();
  assert.equal(await consent.getByLabel("Exact signing challenge").inputValue(), challenge);
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 850 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await consent.screenshot({ path: resolve(shots, "consent-" + width + ".png") });
  }
  await history.getByRole("button", { name: "Look up delegation" }).click();
  await history.getByText(terms.delegationId, { exact: true }).waitFor();
  assert.equal(await consent.count(), 0);
  assert.equal(writes.length, 2);
  await submit.click();
  await key.fill("demo-key");
  await create.click();
  await consent.getByText("No challenge is available", { exact: false }).waitFor();
  assert.equal(await consent.getByLabel("Exact signing challenge").count(), 0);
  const expected = { operation: "create", grantId: "recent-grant", agentId: "reporter", keyId: "demo-key" };
  assert.deepEqual(writes, [expected, expected, expected]);
  for (const [value, message] of [["malformed", "unavailable"], ["missing", "not found"], ["swapped", "unavailable"], ["login", "Sign in"]]) {
    await id.fill(value);
    await submit.click();
    await page.getByRole("status").filter({ hasText: message }).waitFor();
    assert.equal(await title.count(), 0);
  }
  await page.getByRole("status").getByRole("link", { name: "Sign in" }).click();
  await page.locator('a[href="/api/auth/start/google?returnTo=%2Fcontract-request"]').waitFor();
  assert.equal(historyReads, 5);
  assert.equal(calls.filter(([, path]) => path === recentHistoryPath).length, 1);
  assert.deepEqual(calls.filter(([m, path]) => m === "GET" && path !== historyPath && path !== recentHistoryPath), ["req", "req", "pending", "legacy", "current", "current", "malformed", "missing", "swapped", "login"].map(value =>
    ["GET", "/api/control/demo/contract-request/" + value + "?view=grant-history"]));
  assert.deepEqual(calls.filter(([m]) => m !== "GET"), Array(5).fill(["POST", "/api/control/demo/delegations"]));
  const issuanceCalls = [];
  const issuePrefix = origin + "/api/control/demo/";
  const record = object => ({ json: { ok: true, object } });
  let recoveryReads = 0;
  await page.route(issuePrefix + "delegation-issuance/proven-delegation", r => {
    assert.equal(r.request().method(), "GET");
    recoveryReads++;
    return r.fulfill(record({ tenantId: "demo", grantId: "proven-grant", requestId: "proven",
      delegationId: "proven-delegation", contractId: "proven-contract" }));
  });
  await page.route(issuePrefix + "contract-request/proven?*", r => r.fulfill(record({
    tenantId: "demo", id: "proven", recordedState: "proposed", releaseId: terms.releaseId, requestedAgentId: terms.agentId,
    actionDigest: terms.actionDigest, requestedAt: grantedAt.toISOString(),
    grantReference: { grantId: "proven-grant", grantedAt: grantedAt.toISOString(), expiresAt }
  })));
  await page.route(issuePrefix + "grant-delegation/proven-grant", r => r.fulfill(record({
    tenantId: "demo", grantId: "proven-grant", requestId: "proven", agentId: terms.agentId, keyId: terms.keyId,
    expiresAt, verifiedAt: grantedAt.toISOString(), delegationId: "proven-delegation", revokedAt: null
  })));
  await page.route(issuePrefix + "contract-issuances", r => {
    assert.equal(r.request().method(), "POST");
    assert.deepEqual(r.request().postDataJSON(), { delegationId: "proven-delegation" });
    issuanceCalls.push("issue");
    if (issuanceCalls.length === 1) return r.abort("failed");
    if (issuanceCalls.length === 2) return r.fulfill({ status: 409, json: { ok: false, code: "contract_issuance_unavailable" } });
    return r.fulfill({ status: 201, headers: { Location: "/api/control/demo/contract/proven-contract" },
      json: { ok: true, issuance: { delegationId: "proven-delegation", contractId: "proven-contract" } } });
  });
  await page.route(issuePrefix + "contract/proven-contract", r => {
    assert.equal(r.request().method(), "GET");
    issuanceCalls.push("read");
    return r.fulfill(record({ schemaVersion: "0.1", id: "proven-contract", tenantId: "demo", semanticReleaseId: terms.releaseId,
      principalId: terms.requesterId, agentId: terms.agentId, actionDigest: terms.actionDigest, policyRevision: "p1",
      sourceRevision: "s1", target: "orders", actionType: "data.read", authority: { mode: "human", reference: "proven-grant" },
      reservationId: "fixture", expiresAt, state: "authorized" }));
  });
  await page.goto(origin + "/contract-request");
  await page.getByLabel("Tenant ID").fill("demo");
  await id.fill("proven");
  await submit.click();
  const issue = page.getByRole("button", { name: "Issue Approval Contract" });
  await history.getByRole("button", { name: "Look up delegation" }).click();
  await issue.waitFor();
  assert.deepEqual(issuanceCalls, []);
  for (const message of ["Issuance not verified.", "The issuer refused this command.", "Recorded contract:"]) {
    await issue.evaluate(button => { button.click(); button.click(); });
    await history.getByText(message, { exact: false }).waitFor();
    assert.ok(await issue.isDisabled());
    if (message === "Issuance not verified.") {
      await recover.click();
      await history.getByText("proven-contract", { exact: true }).waitFor();
      assert.equal(recoveryReads, 1);
      assert.deepEqual(issuanceCalls, ["issue"]);
    }
    if (message !== "Recorded contract:") await history.getByRole("button", { name: "Refresh delegation history" }).click();
  }
  assert.deepEqual(issuanceCalls, ["issue", "issue", "issue", "read"]);
  // All earlier registered routes still record unexpected API traffic.
  assert.equal(calls.filter(([, path]) => /budget-admission|job-preparation|handoff/.test(path)).length, 0);
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 850 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await history.screenshot({ path: resolve(shots, "contract-issuance-" + width + ".png") });
  }
  const budgetWrites = [], quoteReads = [];
  await page.route(issuePrefix + "budget-quote/proven-contract", r => {
    quoteReads.push(r.request().method());
    return r.fulfill(record({ tenantId: "demo", contractId: "proven-contract", delegationId: "proven-delegation",
      actionDigest: terms.actionDigest, expiresAt, budgetId: "analytics", microUsd: 80 }));
  });
  await page.route(issuePrefix + "budget-admissions", r => {
    assert.equal(r.request().method(), "POST");
    budgetWrites.push(r.request().postDataJSON());
    if (budgetWrites.length === 1) return r.abort("failed");
    if (budgetWrites.length === 2) return r.fulfill({ status: 409, json: { ok: false, code: "budget_admission_unavailable" } });
    return r.fulfill({ status: 201, json: { ok: true, admission: { contractId: "proven-contract", intentId: "intent-1" } } });
  });
  await recover.click();
  const budget = page.getByRole("region", { name: "Budget reservation" });
  const review = budget.getByRole("button", { name: "Review budget reservation" });
  const reserve = budget.getByRole("button", { name: "Confirm reservation" });
  await review.waitFor();
  assert.deepEqual(quoteReads, []);
  await review.click();
  await budget.getByText("80 micro-USD", { exact: true }).waitFor();
  await budget.getByText("analytics", { exact: true }).waitFor();
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 850 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await budget.screenshot({ path: resolve(shots, "budget-review-" + width + ".png") });
  }
  await budget.getByRole("button", { name: "Cancel" }).click();
  assert.deepEqual(budgetWrites, []);
  assert.equal(await reserve.count(), 0);
  let admissionReads = 0;
  await page.route(issuePrefix + "contract-admission/proven-contract", route => {
    assert.equal(route.request().method(), "GET");
    admissionReads++;
    if (admissionReads === 1) return route.fulfill({ status: 404, json: { ok: false, code: "not_found" } });
    return route.fulfill(record({ tenantId: "demo", contractId: "proven-contract", delegationId: "proven-delegation",
      actionDigest: terms.actionDigest, intentId: "intent-1", budgetId: "analytics", originalMicroUsd: 80 }));
  });
  for (const message of ["Reservation not verified.", "Budget admission refused", "Reservation acknowledged."]) {
    await review.click();
    await reserve.evaluate(b => { b.click(); b.click(); });
    await budget.getByRole("status").filter({ hasText: message }).waitFor();
    if (message === "Reservation not verified.") {
      assert.equal(await review.count(), 0);
      await readReservation.click();
      await pastReservation.getByText("No reservation record is visible for this contract.").waitFor();
      assert.equal(budgetWrites.length, 1);
    }
  }
  await readReservation.click();
  await pastReservation.getByText("intent-1", { exact: true }).waitFor();
  const receipts = pastReservation.getByRole("region", { name: "Intent receipt" });
  const lookup = receipts.getByRole("button", { name: "Look up receipt" });
  const jobId = "odap_" + createHash("sha256").update(JSON.stringify(["odap.job.v1","demo","intent-1"])).digest("hex");
  const summary = { tenantId:"demo",recordedAt:"2026-01-01T00:00:00.000Z",hasContract:true,hasSemanticRelease:true };
  const stages = [null,{...summary,id:"pending_"+jobId,outcome:"pending"},{...summary,id:"final_"+jobId,outcome:"succeeded"}];
  let receiptReads = 0;
  await page.route(issuePrefix + "intent-receipt/intent-1", route => {
    assert.equal(route.request().method(), "GET");
    const n = receiptReads++;
    if (n === stages.length) return route.fulfill({ status:403,json:{ok:false,code:"tenant_access_denied"} });
    return route.fulfill(record({tenantId:"demo",contractId:"proven-contract",delegationId:"proven-delegation",
      actionDigest:terms.actionDigest,intentId:"intent-1",receipt:stages[n]}));
  });
  for (const message of ["No receipt is linked","Pending receipt","Final receipt: Succeeded"]) {
    await lookup.click();
    await receipts.getByRole("status").filter({ hasText:message }).waitFor();
  }
  for (const width of [390,1280]) {
    await page.setViewportSize({ width,height:850 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await receipts.screenshot({ path: resolve(shots,"intent-receipt-"+width+".png") });
  }
  await lookup.click();
  await receipts.getByText("You do not have access to this tenant.").waitFor();
  assert.equal(await receipts.getByText("final_"+jobId).count(),0);
  assert.equal(receiptReads,4);
  assert.equal(await budget.count(), 0);
  assert.equal(admissionReads, 2);
  assert.deepEqual(quoteReads, Array(4).fill("GET"));
  assert.deepEqual(budgetWrites, Array(3).fill({ contractId: "proven-contract" }));
  assert.equal(calls.filter(([, path]) => /job-preparation|handoff/.test(path)).length, 0);
  assert.deepEqual(errors, []);
  console.log("Request history UI passed: consent, revocation, issuance, recovery and explicit budget confirmation at both widths.");
});
