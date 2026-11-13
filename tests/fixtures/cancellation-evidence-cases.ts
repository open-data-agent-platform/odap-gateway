import { describe, expect, it, vi } from "vitest";
import type { CancellationFixture } from "./delegated-cancellation-cases";
import { requestDelegatedCancellation } from "../../lib/delegated-cancellation";
import { exportCancellationEvidence } from "../../lib/cancellation-evidence-export";
import { verifyCancellationEvidence } from "../../lib/cancellation-evidence";
import { observeDelegatedClaim } from "../../lib/delegated-job-recovery";

export function cancellationEvidenceCases(fixture: () => CancellationFixture) {
  const request = () => { const f = fixture(); return requestDelegatedCancellation(f.owner,f.audience,f.intentId); };
  const read = () => { const f = fixture(); return exportCancellationEvidence(f.owner,f.audience,f.intentId); };
  describe("owner-scoped cancellation provenance export", { timeout: 25000 }, () => {
    it("exports one recorded request in one read without changing the hold or implying a cancellation", async () => {
      const f = fixture(); expect(await read()).toBeNull(); await request();
      const before = await f.first("SELECT reserved_units,spent_units FROM control_budgets WHERE tenant_id='t' AND id='b'");
      const run = vi.fn(() => { throw new Error("Export must not write"); });
      const prepare = vi.fn((q: string) => { const p=f.owner.db.prepare(q); return { ...p, bind(...args: Parameters<typeof p.bind>) {
        const bound=p.bind(...args); return { ...bound, first:<T>(column?:string)=>bound.first<T>(column),run };
      } }; });
      const result = await exportCancellationEvidence({ ...f.owner,db:{ prepare } },f.audience,f.intentId);
      expect(result).not.toBeNull(); expect(prepare).toHaveBeenCalledTimes(1); expect(run).not.toHaveBeenCalled();
      if (!result) throw new Error("Missing export");
      expect(await verifyCancellationEvidence(result.json,{ tenantId:"t",intentId:f.intentId,audience:f.audience },result.digest))
        .toMatchObject({ consistent:true,issuerAuthenticated:false,cancellationConfirmed:false,scope:"recorded-request-only" });
      expect(JSON.parse(result.json).request.requestedBy).toBe(f.owner.principalId);
      expect(result.json).not.toMatch(/SELECT |net_amount|queryParameters|access_token|errorResult|"outcome"/i);
      expect(await f.first("SELECT reserved_units,spent_units FROM control_budgets WHERE tenant_id='t' AND id='b'")).toEqual(before);
    });
    it("requires ownership of this tenant, the expected audience and an existing request", async () => {
      const f = fixture(); await request();
      await f.sql("INSERT INTO control_tenants VALUES('peer','Peer')");
      await f.sql("INSERT INTO control_memberships VALUES('peer','google:reader','owner',1)");
      for (const access of [{ ...f.owner,tenantId:"peer" },{ ...f.owner,principalId:"google:reader" },
        { ...f.owner,tenantId:"peer",principalId:"google:reader" }])
        expect(await exportCancellationEvidence(access,f.audience,f.intentId)).toBeNull();
      expect(await exportCancellationEvidence(f.owner,"wrong",f.intentId)).toBeNull();
      expect(await exportCancellationEvidence(f.owner,f.audience,"missing")).toBeNull();
    });
    it("preserves the original actor after grant withdrawal and owner replacement", async () => {
      const f=fixture(); await request(); const saved=await read();
      expect((await f.revoke(f.delegationId)).status).toBe(200);
      await f.sql("UPDATE control_memberships SET active=0 WHERE tenant_id='t' AND principal_id='google:operator'");
      expect(await read()).toBeNull();
      expect(await exportCancellationEvidence({ ...f.owner,principalId:"google:owner" },f.audience,f.intentId)).toEqual(saved);
    });
    it("checks ownership in the export statement after a concurrent revocation", async () => {
      const f=fixture(); await request();
      const db={ prepare(q:string) { const p=f.owner.db.prepare(q); return { ...p, bind(...args:Parameters<typeof p.bind>) {
        const b=p.bind(...args); return { ...b, async first<T>() {
          await f.sql("UPDATE control_memberships SET active=0 WHERE tenant_id='t' AND principal_id='google:operator'");
          return b.first<T>();
        } };
      } }; } };
      expect(await exportCancellationEvidence({ ...f.owner,db },f.audience,f.intentId)).toBeNull();
    });
    it.each(["succeeded","failed","cancelled"])("does not rewrite the request when an independent observation reports %s", async outcome => {
      const f=fixture(); await request(); const saved=await read();
      await observeDelegatedClaim(f.owner,f.audience,f.intentId,async () => Response.json({ jobReference:f.ref,
        configuration:{ jobType:"QUERY",labels:{ odap_action:f.tag },query:{ maximumBytesBilled:f.cap } },
        status:{ state:"DONE",...(outcome!=="succeeded"&&{ errorResult:{ reason:outcome==="cancelled"?"stopped":"invalid" } }) },
        statistics:{ query:{} } }));
      expect(await read()).toEqual(saved);
    });
    it.each(["delegation_audience=NULL","delegation_audience='wrong'","claim_body_digest='wrong'","job_id='wrong'"])(
      "withholds legacy or damaged request attribution: %s",async change => {
        const f=fixture(); await request();
        await f.sql("DROP TRIGGER cancellation_request_no_update");
        await f.sql("UPDATE bigquery_cancellation_requests SET "+change);
        expect(await read()).toBeNull();
      });
    it("withholds the export when the linked pending receipt creation event is missing",async () => {
      const f=fixture(); await request();
      await f.sql("DROP TRIGGER IF EXISTS control_event_no_delete");
      await f.sql("DELETE FROM control_object_events WHERE tenant_id='t' AND object_kind='receipt'");
      expect(await read()).toBeNull();
    });
  });
}
