import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SESSION_COOKIE, signAuthPayload } from "../lib/auth";
import { inspectApprovalContract } from "../lib/contract-inspection";
import worker from "../worker";
import { jobDatabase, jobSqlite } from "./fixtures/job-sqlite";

const signal = new AbortController().signal;
const contract = { id:"c",tenantId:"t",schemaVersion:"0.1",state:"authorized",authority:{ mode:"policy",reference:"private-ref" },
  semanticReleaseId:"r",actionDigest:"sha256:" + "a".repeat(64),target:"metric",actionType:"data.read",agentId:"a",
  principalId:"private-subject",reservationId:"private-reservation",sourceRevision:"s1",policyRevision:"p1",expiresAt:"2026-01-01T00:00:00.000Z" };
describe("approval contract inspector", () => {
  it.each([[-1,false],[0,true],[1,true]] as const)("keeps lifecycle separate from expiry at the lookup boundary (%i ms)", async (delta,expired) => {
    const clock = vi.spyOn(Date,"now").mockReturnValue(Date.parse(contract.expiresAt)+delta);
    const get = vi.fn(async () => Response.json({ ok:true,object:contract }));
    try {
      const result = await inspectApprovalContract("t","c",signal,get);
      expect(result).toMatchObject({ state:"ready",snapshot:{ state:"authorized",authorityMode:"policy",expiredAtLookup:expired } });
      expect(JSON.stringify(result)).not.toMatch(/private-|eligible"/);
      expect(get).toHaveBeenCalledWith("/api/control/t/contract/c",{
        method:"GET",credentials:"same-origin",cache:"no-store",redirect:"error",signal
      });
    } finally { clock.mockRestore(); }
  });
  it("does not fetch invalid scope, accept swapped IDs, or render arbitrary server fields", async () => {
    const get = vi.fn();
    for (const [tenant,id] of [["t","../x"],["t/x","y"],["t",""],["t","x".repeat(129)]])
      expect(await inspectApprovalContract(tenant,id,signal,get)).toEqual({ state:"invalid" });
    expect(get).not.toHaveBeenCalled();
    for (const override of [{ id:"different" },{tenantId:"peer"},{state:"eligible"},{expiresAt:"yesterday"},{additional:"secret"}])
      expect(await inspectApprovalContract("t","c",signal,async () => Response.json({
        ok:true,object:{ ...contract,...override }
      }))).toEqual({state:"unavailable"});
    for (const read of [async () => new Response("Not implemented",{status:404}),
      async () => Response.json({ok:false,code:"storage"},{status:503}),async () => { throw new Error("private"); }])
      expect(await inspectApprovalContract("t","c",signal,read)).toEqual({state:"unavailable"});
  });
});

describe("effective-contract read through local Worker and SQLite", () => {
  let dir: string, file: string;
  const env = { DB:jobDatabase(() => file,"readonly"),AUTH_COOKIE_SECRET:"synthetic-inspection-cookie-key",
    ASSETS:{ fetch:async () => { throw new Error("Unexpected asset read"); } } };
  const sql = (q: string) => jobSqlite(file,"run",q);
  async function inspect(tenant: string, subject: string, id = "c") {
    const cookie = subject ? SESSION_COOKIE+"="+await signAuthPayload({provider:"google",providerId:subject,
      name:"Fixture",email:"fixture@example.test",expiresAt:Date.now()+60000},env.AUTH_COOKIE_SECRET) : "";
    return inspectApprovalContract(tenant,id,signal,(path,init) => worker.fetch(
      new Request(new URL(String(path),"https://gateway.test"),{ ...init,headers:{ Cookie:cookie,"X-Principal-Id":"google:owner" } }),
      env,{waitUntil:() => undefined}));
  }
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(),"odap-contract-inspect-"));
    file = join(dir,"fixture.db");
    await jobSqlite(file,"setup");
    await sql("INSERT INTO control_tenants VALUES('peer','Peer')");
    await sql(`INSERT INTO control_memberships VALUES ('t','google:owner','owner',1),('t','google:reader','reader',1),
      ('t','google:reviewer','reviewer',1),('t','google:inactive','owner',0),('peer','google:owner','reader',1)`);
    await sql(`INSERT INTO semantic_releases(tenant_id,id,payload,created_by)
      SELECT 'peer',id,json_set(payload,'$.tenantId','peer'),created_by FROM semantic_releases WHERE tenant_id='t'`);
    await sql(`INSERT INTO approval_contracts(tenant_id,id,release_id,payload,created_by)
      SELECT 'peer',id,release_id,json_set(payload,'$.tenantId','peer','$.target','peer-orders'),created_by
      FROM approval_contracts WHERE tenant_id='t'`);
  });
  afterAll(async () => { if (dir) await rm(dir,{recursive:true,force:true}); });
  it("reads the consumed lifecycle, not the immutable authorized payload, for all three permitted roles", async () => {
    expect(await jobSqlite(file,"readonly-first","SELECT json_extract(payload,'$.state') original FROM approval_contracts WHERE tenant_id='t'"))
      .toEqual({original:"authorized"});
    for (const subject of ["owner","reviewer","reader"])
      expect(await inspect("t",subject)).toMatchObject({ state:"ready",snapshot:{state:"consumed",target:"orders"} });
  });
  it("does not borrow a same-ID contract from another tenant and reflects revocation on reread", async () => {
    expect(await inspect("peer","owner")).toMatchObject({state:"ready",snapshot:{tenantId:"peer",target:"peer-orders",state:"authorized"}});
    await sql("UPDATE contract_lifecycle SET state='revoked',reason='fixture withdrawal',changed_by='test' WHERE tenant_id='peer' AND contract_id='c'");
    expect(await inspect("peer","owner")).toMatchObject({state:"ready",snapshot:{state:"revoked"}});
    expect(await inspect("t","owner")).toMatchObject({state:"ready",snapshot:{state:"consumed"}});
  });
  it("distinguishes unauthenticated, forbidden and absent records without exposing an object", async () => {
    expect(await inspect("t","")).toEqual({state:"unauthenticated"});
    expect(await inspect("t","inactive")).toEqual({state:"denied"});
    expect(await inspect("peer","reader")).toEqual({state:"denied"});
    expect(await inspect("t","reader","absent")).toEqual({state:"not_found"});
  });
});
