import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe } from "vitest";
import type { D1Database } from "../lib/d1";
import { delegationFixture } from "./fixtures/delegation";
import type { CancellationFixture } from "./fixtures/delegated-cancellation-cases";
import { jobSqlite } from "./fixtures/job-sqlite";
import { settledEvidenceRequestCases } from "./fixtures/settled-evidence-request-cases";
import { settledEvidenceMcpCases } from "./fixtures/settled-evidence-mcp-cases";

let mf: Miniflare, f: CancellationFixture, statements: string[], sequence = 0;
describe("settled evidence export on native D1", () => {
  beforeAll(async () => { statements = await jobSqlite(":memory:", "migration-statements"); });
  beforeEach(async () => {
    await mf?.dispose();
    mf = new Miniflare({ host: "127.0.0.1", port: 0, modules: true,
      script: "export default {fetch(){return new Response('Local evidence export');}}",
      d1Databases: { DB: "local-evidence-export-"+(++sequence) }, d1Persist: false });
    const db = await mf.getD1Database("DB") as unknown as D1Database;
    await db.batch!(statements.map(q => db.prepare(q)));
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
    const sql = (q: string, params: string[] = []) => db.prepare(q).bind(...params).run();
    const first = async (q: string) => { const row = await db.prepare(q).first(); if (!row) throw new Error("Fixture row missing"); return row; };
    const fixture = delegationFixture(() => { throw new Error("No SQLite fallback"); }, () => pair, { db, sql, first,
      migrate: async mode => {
        if (mode === "setup-v19") return db.batch!([
          db.prepare("INSERT INTO control_tenants VALUES('t','Tenant')"),
          db.prepare("INSERT INTO control_budgets(tenant_id,id,limit_units) VALUES('t','b',100)")
        ]);
        if (!["apply-agent-delegations", "apply-contract-issuance", "apply-delegated-budget", "apply-delegated-jobs", "apply-delegated-handoff"].includes(mode))
          throw new Error("Unexpected migration request");
      } });
    const job = await fixture.seedAmbiguousDelegation(async () => {});
    f = { ...job, owner: { db, tenantId: "t", principalId: "google:operator" }, audience: "test-gateway", sql, first, revoke: fixture.revoke };
  }, 60000);
  afterAll(async () => { await mf?.dispose(); });
  settledEvidenceRequestCases(() => f);
  settledEvidenceMcpCases(() => f);
});
