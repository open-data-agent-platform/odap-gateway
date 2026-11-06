import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../worker";

const sensitive = "synthetic-only: token=private-value; SELECT private_column; fixture@example.test";
const kinds = ["error", "string", "message-getter", "prototype-trap"] as const;
type FailureKind = typeof kinds[number];
const expected = { ok: false, code: "internal_error", message: "ODAP Gateway could not complete this request." };
afterEach(() => vi.restoreAllMocks());

function failure(kind: FailureKind) {
  const inspect = vi.fn(() => { throw new Error("Exception metadata must not be inspected"); });
  const error = new Error(sensitive, { cause: new Error(sensitive) });
  const value = kind === "string" ? sensitive : kind === "prototype-trap" ? new Proxy(error, { getPrototypeOf: inspect }) : error;
  if (kind === "message-getter") Object.defineProperty(error, "message", { get: inspect });
  return { value, inspect };
}

async function assertFailure(response: Response, log: ReturnType<typeof vi.spyOn>) {
  expect(response.status).toBe(500);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(response.headers.get("Content-Type")).toBe("application/json");
  expect(response.headers.get("Set-Cookie")).toBeNull();
  expect(await response.json()).toEqual(expected);
  expect(log.mock.calls).toEqual([[JSON.stringify({ event: "worker_request_failed" })]]);
}

describe.each(["", "/gateway"])("Worker failure boundary at mount '%s'", mount => {
  describe.each(["assets", "storage"] as const)("%s failures", surface => {
    it.each(kinds)("does not inspect or disclose %s exceptions", async kind => {
      const f = failure(kind), log = vi.spyOn(console, "error").mockImplementation(() => {});
      const assets = vi.fn(async () => { throw f.value; });
      const prepare = vi.fn(() => { throw f.value; });
      const outbound = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected outbound request"));
      const path = surface === "assets" ? "/login" : "/api/docs/feedback";
      const response = await worker.fetch(new Request("https://gateway.test" + mount + path), {
        GATEWAY_BASE_PATH: mount, GATEWAY_MODE: "production", ASSETS: { fetch: assets },
        ODAP_GATEWAY_DB: { prepare }
      }, { waitUntil() {} });
      await assertFailure(response, log);
      expect(f.inspect).not.toHaveBeenCalled();
      expect(assets).toHaveBeenCalledTimes(surface === "assets" ? 1 : 0);
      expect(prepare).toHaveBeenCalledTimes(surface === "storage" ? 1 : 0);
      expect(outbound).not.toHaveBeenCalled();
    });
  });
});

it.each(kinds)("sanitizes %s failures when forwarding an adjacent main-site path", async kind => {
  const f = failure(kind), log = vi.spyOn(console, "error").mockImplementation(() => {});
  const outbound = vi.spyOn(globalThis, "fetch").mockRejectedValue(f.value);
  const assets = vi.fn(async () => new Response("Unexpected asset"));
  const request = new Request("https://gateway.test/gateway-other?private=synthetic", {
    headers: { Authorization: "Bearer synthetic-only", Cookie: "synthetic-only" }
  });
  const response = await worker.fetch(request, { GATEWAY_BASE_PATH: "/gateway", GATEWAY_SITE_ORIGIN: "https://gateway.test",
    ASSETS: { fetch: assets } }, { waitUntil() {} });
  await assertFailure(response, log);
  expect(f.inspect).not.toHaveBeenCalled();
  expect(outbound).toHaveBeenCalledTimes(1);
  expect(outbound).toHaveBeenCalledWith(request);
  expect(assets).not.toHaveBeenCalled();
});

it.each([
  ["/gateway/login", "GET", 200, "assets"],
  ["/gateway/api/health", "GET", 200, "none"],
  ["/gateway/api/admin/health", "GET", 401, "none"],
  ["/gateway/api/health", "POST", 405, "none"],
  ["/gateway-other", "GET", 202, "origin"]
] as const)("does not log a failure for %s %s", async (path, method, status, source) => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const assets = vi.fn(async () => new Response("asset"));
  const outbound = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("origin", { status: 202 }));
  const response = await worker.fetch(new Request("https://gateway.test" + path, { method }), {
    GATEWAY_BASE_PATH: "/gateway", GATEWAY_SITE_ORIGIN: "https://gateway.test", ASSETS: { fetch: assets }
  }, { waitUntil() {} });
  expect(response.status).toBe(status);
  expect(log).not.toHaveBeenCalled();
  expect(assets).toHaveBeenCalledTimes(source === "assets" ? 1 : 0);
  expect(outbound).toHaveBeenCalledTimes(source === "origin" ? 1 : 0);
});
