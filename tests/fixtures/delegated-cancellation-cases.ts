import { describe, expect, it, vi } from "vitest";
import { readDelegatedCancellation, requestDelegatedCancellation } from "../../lib/delegated-cancellation";
import { sendRequestedDelegatedJobCancellation, sendRequestedJobCancellation } from "../../lib/bigquery-cancellation-transport";
import { observeDelegatedClaim } from "../../lib/delegated-job-recovery";
import type { ControlAccess } from "../../lib/control-storage";

export type CancellationFixture = {
  owner: ControlAccess; audience: string; intentId: string; delegationId: string;
  ref: { jobId: string; projectId: string; location: string }; tag: string; cap: string;
  sql(q: string, params?: string[]): Promise<unknown>;
  first(q: string): Promise<Record<string, unknown>>;
  revoke(id: string): Promise<Response>;
};

export function delegatedCancellationCases(fixture: () => CancellationFixture) {
  const read = () => { const f = fixture(); return readDelegatedCancellation(f.owner, f.audience, f.intentId); };
  const request = () => { const f = fixture(); return requestDelegatedCancellation(f.owner, f.audience, f.intentId); };
  const ledger = () => fixture().first(`SELECT (SELECT count(*) FROM dispatch_claims) AS claims,
    (SELECT count(*) FROM cost_settlements) AS settlements,(SELECT count(*) FROM evidence_receipts) AS receipts,
    (SELECT reserved_units FROM control_budgets WHERE tenant_id='t' AND id='b') AS reserved,
    (SELECT spent_units FROM control_budgets WHERE tenant_id='t' AND id='b') AS spent`);
  const send = (transport: Parameters<typeof sendRequestedDelegatedJobCancellation>[3]) => {
    const f = fixture(); return sendRequestedDelegatedJobCancellation(f.owner, f.audience, f.intentId, transport);
  };
  const finish = async () => { const f = fixture(); await observeDelegatedClaim(f.owner, f.audience, f.intentId, async () => Response.json({
    jobReference: f.ref, configuration: { jobType: "QUERY", labels: { odap_action: f.tag }, query: { maximumBytesBilled: f.cap } },
    status: { state: "DONE", errorResult: { reason: "stopped" } }, statistics: { query: {} }
  })); };

  describe("verified delegated cancellation", { timeout: 25000 }, () => {
    it("requires an explicit request and permits owner recovery after delegation withdrawal", async () => {
      const f = fixture(), before = await ledger(), getAccessToken = vi.fn(async () => "synthetic"), sendOnce = vi.fn(async () => new Response(null));
      expect(await read()).toMatchObject({ state: "not-requested", request: null });
      expect(await send({ getAccessToken, sendOnce })).toMatchObject({ state: "not-sent", reason: "not-requested" });
      expect(getAccessToken).not.toHaveBeenCalled(); expect(sendOnce).not.toHaveBeenCalled();
      expect((await f.revoke(f.delegationId)).status).toBe(200);
      const saved = await request();
      expect(saved).toMatchObject({ state: "requested", jobReference: f.ref, request: { requestedBy: f.owner.principalId, verified: true },
        witness: { audience: f.audience, claimBodyDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) } });
      expect(await send({ getAccessToken, sendOnce })).toMatchObject({ state: "observation-required", jobReference: f.ref });
      expect(sendOnce).toHaveBeenCalledTimes(1);
      expect(await read()).toEqual(saved); expect(await ledger()).toEqual(before);
    });
    it("denies other tenants, audiences, principals and the legacy sender before credentials", async () => {
      const f = fixture(); await request();
      const getAccessToken = vi.fn(), sendOnce = vi.fn();
      for (const [owner, audience, id] of [[{ ...f.owner, tenantId: "peer" }, f.audience, f.intentId],
        [{ ...f.owner, principalId: "google:reader" }, f.audience, f.intentId], [f.owner, "other", f.intentId],
        [f.owner, f.audience, "absent"]] as const) {
        await expect(requestDelegatedCancellation(owner, audience, id)).rejects.toThrow();
        await expect(sendRequestedDelegatedJobCancellation(owner, audience, id, { getAccessToken, sendOnce })).rejects.toThrow("unavailable");
      }
      await expect(sendRequestedJobCancellation(f.owner, f.intentId, { getAccessToken, sendOnce })).rejects.toThrow("unavailable");
      expect(getAccessToken).not.toHaveBeenCalled(); expect(sendOnce).not.toHaveBeenCalled();
    });
    it("preserves the first owner and timestamp across concurrent requests and immutable-write attempts", async () => {
      const f = fixture();
      const [a, b] = await Promise.all([request(), requestDelegatedCancellation({ ...f.owner, principalId: "google:owner" }, f.audience, f.intentId)]);
      expect(b).toEqual(a); expect(await request()).toEqual(a);
      await f.sql(`INSERT OR REPLACE INTO bigquery_cancellation_requests
        (tenant_id,intent_id,job_id,requested_by,delegation_audience,claim_body_digest) VALUES('t',?,?,'google:owner',?,?)`,
      [f.intentId, f.ref.jobId, f.audience, a.witness.claimBodyDigest]);
      expect(await read()).toEqual(a);
      await expect(f.sql("UPDATE bigquery_cancellation_requests SET requested_by='google:owner'")).rejects.toThrow("immutable");
      await expect(f.sql("DELETE FROM bigquery_cancellation_requests")).rejects.toThrow("immutable");
    });
    it.each(["missing", "audience", "digest", "job"])("rejects a direct write with %s attribution", async kind => {
      const f = fixture(), digest = (await read()).witness.claimBodyDigest;
      if (kind === "missing") await expect(f.sql(`INSERT INTO bigquery_cancellation_requests
        (tenant_id,intent_id,job_id,requested_by) VALUES('t',?,?,'google:operator')`, [f.intentId, f.ref.jobId])).rejects.toThrow();
      else await expect(f.sql(`INSERT INTO bigquery_cancellation_requests
        (tenant_id,intent_id,job_id,requested_by,delegation_audience,claim_body_digest) VALUES('t',?,?,'google:operator',?,?)`,
      [f.intentId, kind === "job" ? "wrong" : f.ref.jobId, kind === "audience" ? "wrong" : f.audience,
        kind === "digest" ? "sha256:" + "f".repeat(64) : digest])).rejects.toThrow();
      expect((await read()).state).toBe("not-requested");
    });
    it.each(["active=0", "role='reader'"])("rechecks owner after token preparation: %s", async change => {
      const f = fixture(); await request(); const before = await ledger(), sendOnce = vi.fn();
      await expect(send({ sendOnce, getAccessToken: async () => {
        await f.sql(`UPDATE control_memberships SET ${change} WHERE tenant_id='t' AND principal_id='google:operator'`); return "synthetic";
      } })).rejects.toThrow(/^BigQuery cancellation transport unavailable$/);
      expect(sendOnce).not.toHaveBeenCalled(); expect(await ledger()).toEqual(before);
    });
    it("does not send or release funds when a terminal observation wins during token preparation", async () => {
      await request(); const before = await ledger(), sendOnce = vi.fn();
      expect(await send({ sendOnce, getAccessToken: async () => { await finish(); return "synthetic"; } }))
        .toMatchObject({ state: "not-sent", reason: "terminal" });
      expect(sendOnce).not.toHaveBeenCalled(); expect(await ledger()).toEqual(before);
    });
    it("does not create a late request after terminal evidence", async () => {
      await finish(); expect(await request()).toMatchObject({ state: "terminal", request: null });
      expect(await fixture().first("SELECT count(*) AS n FROM bigquery_cancellation_requests")).toEqual({ n: 0 });
    });
    it("keeps the hold and pending evidence after an uncertain send, with no retry", async () => {
      await request(); const before = await ledger(), sendOnce = vi.fn(async () => { throw new Error("private diagnostic"); });
      expect(await send({ sendOnce, getAccessToken: async () => "synthetic" })).toMatchObject({ state: "observation-required" });
      expect(sendOnce).toHaveBeenCalledTimes(1); expect(await ledger()).toEqual(before);
    });
  });
}
