import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe } from "vitest";
import type { D1Database } from "../lib/d1";
import { jobSqlite } from "./fixtures/job-sqlite";
import { auxiliaryExportCases } from "./fixtures/auxiliary-export-cases";

let mf: Miniflare, db: D1Database, statements: string[], sequence=0;
describe("auxiliary evidence export on installed native D1",() => {
  beforeAll(async () => {statements=await jobSqlite(":memory:","migration-statements");});
  beforeEach(async () => {
    await mf?.dispose();
    mf=new Miniflare({host:"127.0.0.1",port:0,modules:true,
      script:"export default {fetch(){return new Response('Local auxiliary export test');}}",
      d1Databases:{DB:"local-auxiliary-export-"+(++sequence)},d1Persist:false});
    db=await mf.getD1Database("DB") as unknown as D1Database;
    await db.batch!(statements.map(sql=>db.prepare(sql)));
    const digest="sha256:"+"b".repeat(64);
    await db.batch!([
      db.prepare("INSERT INTO control_tenants VALUES('t','Tenant')"),
      db.prepare("INSERT INTO control_memberships VALUES('t','owner','owner',1),('t','user','reader',1)"),
      db.prepare("INSERT INTO semantic_releases(tenant_id,id,payload,created_by) VALUES('t','r',?,'owner')").bind(JSON.stringify({id:"r",tenantId:"t"})),
      db.prepare("INSERT INTO approval_contracts(tenant_id,id,release_id,payload,created_by) VALUES('t','c','r',?,'owner')")
        .bind(JSON.stringify({id:"c",tenantId:"t",semanticReleaseId:"r",state:"authorized",principalId:"user",actionDigest:digest,
          reservationId:"s",expiresAt:"2099-01-01T00:00:00.000Z"})),
      db.prepare("INSERT INTO control_budgets(tenant_id,id,limit_units) VALUES('t','b',100)"),
      db.prepare("INSERT INTO execution_intents VALUES('t','i','c','b','s','user',?,20,'now')").bind(digest)
    ]);
  },30000);
  afterAll(async () => {await mf?.dispose();});
  auxiliaryExportCases(() => ({db,tenantId:"t",principalId:"owner"}));
});
