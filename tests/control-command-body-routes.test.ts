import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../worker";
import { SESSION_COOKIE, signAuthPayload } from "../lib/auth";
import type { D1PreparedStatement } from "../lib/d1";

const commands = [
  ["proposals", "proposal"], ["validations", "validation"], ["approvals", "approval"],
  ["promotions", "promotion"], ["withdrawals", "withdrawal"], ["retirements", "retirement"],
  ["contract-requests", "contract_request"], ["metric-previews", "metric_preview"],
  ["human-grants", "human_grant"], ["human-grant-reviews", "human_grant_review"],
  ["delegations", "delegation"], ["delegation-proofs", "delegation_proof"],
  ["contract-issuances", "contract_issuance"], ["budget-admissions", "budget_admission"],
  ["job-preparations", "job_preparation"], ["receipt-corrections/receipt", "receipt_correction"]
];

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe.each(commands)("control body admission through %s", (path, kind) => {
  it.each(["timeout", "aborted", "oversized"])("refuses %s before command storage or provider access", async mode => {
    const secret = "synthetic-control-command-secret";
    const token = await signAuthPayload({ provider: "google", providerId: "owner", email: "fixture@example.test",
      name: "Fixture", expiresAt: Date.now() + 60_000 }, secret);
    vi.useFakeTimers();
    const unexpected = () => { throw new Error("Unexpected command storage"); };
    const statement: D1PreparedStatement = {
      bind: () => statement, first: async <T>() => ({ role: "owner" } as T), all: unexpected, run: unexpected
    };
    const prepare = vi.fn((query: string) => {
      if (!query.startsWith("SELECT role FROM control_memberships")) return unexpected();
      return statement;
    });
    const outbound = vi.spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("Unexpected provider call"); });
    let started!: () => void;
    const reading = new Promise<void>(resolve => { started = resolve; });
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const body = new ReadableStream<Uint8Array>({ pull(c) {
      started();
      if (mode === "oversized") c.enqueue(new Uint8Array(48 * 1024 + 1));
    }, cancel }, { highWaterMark: 0 });
    const abort = new AbortController();
    if (mode === "aborted") abort.abort(new Error("synthetic-private-abort"));
    const request = new Request("https://gateway.test/gateway/api/control/t/" + path, {
      method: "POST", body, duplex: "half", signal: abort.signal, headers: { Origin: "https://gateway.test",
        "Content-Type": "application/json", Cookie: SESSION_COOKIE + "=" + token }
    } as RequestInit);
    const response = worker.fetch(request, { DB: { prepare }, AUTH_COOKIE_SECRET: secret,
      ODAP_DELEGATION_AUDIENCE: "fixture", GATEWAY_BASE_PATH: "/gateway",
      ASSETS: { fetch: async () => { throw new Error("Unexpected asset lookup"); } } }, { waitUntil() {} });
    if (mode === "timeout") {
      await reading;
      await vi.advanceTimersByTimeAsync(15_000);
    }
    const result = await response;
    expect(result.status).toBe(mode === "timeout" ? 408 : mode === "oversized" ? 413 : 400);
    expect(await result.json()).toEqual({ ok: false,
      code: mode === "aborted" ? "invalid_" + kind : kind + (mode === "timeout" ? "_timeout" : "_too_large") });
    expect(result.headers.get("Cache-Control")).toBe("no-store");
    expect(prepare).toHaveBeenCalledTimes(kind === "delegation_proof" ? 0 : 1);
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
    expect(outbound).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
