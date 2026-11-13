import { describe, expect, it, vi } from "vitest";
import { observeDelegatedJobWithTransport } from "../../lib/delegated-observation-transport";
import { readDelegatedRecovery } from "../../lib/delegated-job-recovery";
import { requestDelegatedCancellation } from "../../lib/delegated-cancellation";
import type { CancellationFixture } from "./delegated-cancellation-cases";

export function delegatedObservationTransportCases(fixture: () => CancellationFixture) {
  const resource = (state = "DONE", reason?: string) => {
    const f = fixture();
    return { jobReference: f.ref, configuration: { jobType: "QUERY", labels: { odap_action: f.tag },
      query: { maximumBytesBilled: f.cap } }, status: { state, ...(reason && { errorResult: { reason } }) },
    statistics: { query: { totalBytesBilled: "0" } } };
  };
  const ledger = () => fixture().first(`SELECT (SELECT count(*) FROM dispatch_claims) AS claims,
    (SELECT count(*) FROM cost_settlements) AS settlements,(SELECT count(*) FROM evidence_receipts) AS receipts,
    (SELECT reserved_units FROM control_budgets WHERE tenant_id='t' AND id='b') AS reserved,
    (SELECT spent_units FROM control_budgets WHERE tenant_id='t' AND id='b') AS spent`);
  const rows = () => fixture().first("SELECT count(*) AS n FROM bigquery_terminal_observations");
  const invoke = (sendOnce: (request: Request) => Promise<Response>, getAccessToken: (signal: AbortSignal) => Promise<string> = async () => "synthetic") => {
    const f = fixture();
    return observeDelegatedJobWithTransport(f.owner, f.audience, f.intentId, { ...f.ref, sendOnce, getAccessToken });
  };

  describe("explicit delegated metadata transport", { timeout: 30000 }, () => {
    it.each([[undefined, "succeeded"], ["invalidQuery", "failed"], ["stopped", "cancelled"]] as const)
      ("observes %s after a cancellation request without inferring causation or releasing funds", async (reason, outcome) => {
        const f = fixture();
        await requestDelegatedCancellation(f.owner, f.audience, f.intentId);
        const request = await f.first("SELECT * FROM bigquery_cancellation_requests"), before = await ledger();
        expect((await f.revoke(f.delegationId)).status).toBe(200);
        const getAccessToken = vi.fn(async (signal: AbortSignal) => { expect(signal.aborted).toBe(false); return "synthetic"; });
        const sendOnce = vi.fn(async (request: Request) => {
          const url = new URL(request.url);
          expect(url.origin).toBe("https://bigquery.googleapis.com");
          expect(url.pathname).toBe(`/bigquery/v2/projects/${encodeURIComponent(f.ref.projectId)}/jobs/${f.ref.jobId}`);
          expect([...url.searchParams.keys()]).toEqual(["location", "fields"]);
          expect(url.searchParams.get("location")).toBe(f.ref.location);
          expect(url.searchParams.get("fields")).toBe("jobReference,configuration(jobType,dryRun,labels,query/maximumBytesBilled),status(state,errorResult/reason),statistics/query/totalBytesBilled");
          expect(request.method).toBe("GET"); expect(request.body).toBeNull(); expect(request.redirect).toBe("manual");
          expect([...request.headers]).toEqual([["authorization", "Bearer synthetic"]]);
          expect(request.signal.aborted).toBe(false);
          return Response.json(resource("DONE", reason));
        });
        const saved = await invoke(sendOnce, getAccessToken);
        expect(saved.observation).toMatchObject({ state: outcome, billedBytes: 0, observedBy: f.owner.principalId });
        expect(await readDelegatedRecovery(f.owner, f.audience, f.intentId)).toEqual(saved);
        expect(getAccessToken).toHaveBeenCalledOnce(); expect(sendOnce).toHaveBeenCalledOnce();
        expect(await rows()).toEqual({ n: 1 }); expect(await ledger()).toEqual(before);
        expect(await f.first("SELECT * FROM bigquery_cancellation_requests")).toEqual(request);
      });
    it.each(["404", "RUNNING"])("keeps stronger stored evidence after %s without resubmitting", async state => {
      const before = await ledger(), f = fixture();
      const response = () => state === "404" ? new Response(null, { status: 404 }) : Response.json(resource(state));
      const read = vi.fn(async () => response());
      expect((await invoke(read)).observation).toEqual({ state: state === "404" ? "not-found" : "pending" });
      expect(await rows()).toEqual({ n: 0 });
      const saved = await invoke(async () => Response.json(resource()));
      expect(await invoke(read)).toEqual(saved); expect(read).toHaveBeenCalledTimes(2);
      expect(await ledger()).toEqual(before);
      expect(await f.first("SELECT count(*) AS n FROM bigquery_cancellation_requests")).toEqual({ n: 0 });
    });
    it("denies wrong tenant, audience, intent and nonowner before authentication", async () => {
      const f = fixture(), getAccessToken = vi.fn(), sendOnce = vi.fn();
      await f.sql("INSERT INTO control_tenants VALUES('peer','Peer')");
      await f.sql("INSERT INTO control_memberships VALUES('peer','google:operator','owner',1)");
      for (const [access, audience, id] of [[{ ...f.owner, tenantId: "peer" }, f.audience, f.intentId],
        [{ ...f.owner, principalId: "google:reader" }, f.audience, f.intentId], [f.owner, "other", f.intentId],
        [f.owner, f.audience, "absent"]] as const)
        await expect(observeDelegatedJobWithTransport(access, audience, id, { ...f.ref, getAccessToken, sendOnce })).rejects.toThrow(/^Delegated observation transport unavailable$/);
      expect(getAccessToken).not.toHaveBeenCalled(); expect(sendOnce).not.toHaveBeenCalled();
    });
    it("retains the original scope, target and sender if the caller mutates inputs during authentication", async () => {
      const f = fixture(), access = { ...f.owner }, sendOnce = vi.fn(async () => Response.json(resource())), replacement = vi.fn();
      const transport = { ...f.ref, sendOnce, getAccessToken: async () => {
        access.tenantId = "peer"; access.principalId = "google:reader";
        transport.projectId = "other-project"; transport.location = "other-region"; transport.sendOnce = replacement;
        return "synthetic";
      } };
      expect((await observeDelegatedJobWithTransport(access,f.audience,f.intentId,transport)).observation).toMatchObject({ state: "succeeded" });
      expect(sendOnce).toHaveBeenCalledOnce(); expect(replacement).not.toHaveBeenCalled();
      expect((await readDelegatedRecovery(f.owner,f.audience,f.intentId)).observation).toMatchObject({ state: "succeeded" });
    });
    it("denies configured target changes before authentication", async () => {
      const f = fixture(), getAccessToken = vi.fn(), sendOnce = vi.fn();
      for (const target of [{ projectId: "other-project" }, { location: "other-region" }])
        await expect(observeDelegatedJobWithTransport(f.owner, f.audience, f.intentId, { ...f.ref, ...target, getAccessToken, sendOnce })).rejects.toThrow("unavailable");
      expect(getAccessToken).not.toHaveBeenCalled(); expect(sendOnce).not.toHaveBeenCalled();
    });
    it.each(["active=0", "role='reader'"])("rechecks ownership after token preparation: %s", async change => {
      const f = fixture(), before = await ledger(), sendOnce = vi.fn();
      await expect(invoke(sendOnce, async () => {
        await f.sql(`UPDATE control_memberships SET ${change} WHERE tenant_id='t' AND principal_id='google:operator'`);
        return "synthetic";
      })).rejects.toThrow("unavailable");
      expect(sendOnce).not.toHaveBeenCalled(); expect(await rows()).toEqual({ n: 0 }); expect(await ledger()).toEqual(before);
    });
    it("rechecks ownership after GET before recording or exposing an observation", async () => {
      const f = fixture(), before = await ledger(), sendOnce = vi.fn(async () => {
        await f.sql("UPDATE control_memberships SET active=0 WHERE tenant_id='t' AND principal_id='google:operator'");
        return Response.json(resource());
      });
      await expect(invoke(sendOnce)).rejects.toThrow("unavailable");
      expect(sendOnce).toHaveBeenCalledOnce(); expect(await rows()).toEqual({ n: 0 }); expect(await ledger()).toEqual(before);
    });
    it("rejects invalid tokens and redacts authentication failures without sending", async () => {
      const sendOnce = vi.fn();
      for (const token of ["", "two words", "non-ascii-\u0080", "line\nbreak"])
        await expect(invoke(sendOnce, async () => token)).rejects.toThrow(/^Delegated observation transport unavailable$/);
      await expect(invoke(sendOnce, async () => { throw new Error("private credential detail"); })).rejects.toThrow(/^Delegated observation transport unavailable$/);
      expect(sendOnce).not.toHaveBeenCalled(); expect(await rows()).toEqual({ n: 0 });
    });
    it("rejects wrong job, label, ceiling and dry-run metadata without recording", async () => {
      const good = resource(), before = await ledger();
      for (const value of [{ ...good, jobReference: { ...good.jobReference, jobId: "other" } },
        { ...good, configuration: { ...good.configuration, labels: { odap_action: "other" } } },
        { ...good, configuration: { ...good.configuration, query: { maximumBytesBilled: "1" } } },
        { ...good, configuration: { ...good.configuration, dryRun: true } }])
        await expect(invoke(async () => Response.json(value))).rejects.toThrow(/^Delegated observation transport unavailable$/);
      expect(await rows()).toEqual({ n: 0 }); expect(await ledger()).toEqual(before);
    });
    it("never follows redirects, retries provider failures or exposes provider body fragments", async () => {
      const before = await ledger();
      for (const status of [302, 403, 503, 200]) {
        const response = new Response("private provider diagnostic", { status, headers: { Location: "https://untrusted.invalid/" } });
        const sendOnce = vi.fn(async () => response);
        await expect(invoke(sendOnce)).rejects.toThrow(/^Delegated observation transport unavailable$/);
        expect(sendOnce).toHaveBeenCalledOnce();
      }
      const redirected = new Response(null, { status: 404 }); Object.defineProperty(redirected, "redirected", { value: true });
      await expect(invoke(async () => redirected)).rejects.toThrow("unavailable");
      const sendOnce = vi.fn(async () => { throw new Error("private transport diagnostic"); });
      await expect(invoke(sendOnce)).rejects.toThrow(/^Delegated observation transport unavailable$/);
      expect(sendOnce).toHaveBeenCalledOnce(); expect(await rows()).toEqual({ n: 0 }); expect(await ledger()).toEqual(before);
    });
    it("recovers a committed observation locally after losing write confirmation", async () => {
      const f = fixture(), before = await ledger(), sendOnce = vi.fn(async () => Response.json(resource("DONE", "stopped")));
      const db: typeof f.owner.db = { prepare(q) {
        const p = f.owner.db.prepare(q); if (!q.startsWith("INSERT INTO bigquery_terminal_observations")) return p;
        return { ...p, bind(...args) { const s = p.bind(...args); return { ...s, async run() {
          await s.run(); throw new Error("private lost acknowledgement");
        } }; } };
      } };
      await expect(observeDelegatedJobWithTransport({ ...f.owner, db }, f.audience, f.intentId,
        { ...f.ref, getAccessToken: async () => "synthetic", sendOnce })).rejects.toThrow("unavailable");
      expect((await readDelegatedRecovery(f.owner, f.audience, f.intentId)).observation).toMatchObject({ state: "cancelled", billedBytes: 0 });
      expect(sendOnce).toHaveBeenCalledOnce(); expect(await rows()).toEqual({ n: 1 }); expect(await ledger()).toEqual(before);
    });
  });
}
