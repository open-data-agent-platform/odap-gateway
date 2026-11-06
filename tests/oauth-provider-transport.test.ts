import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onRequestGet } from "../functions/api/auth/callback/[provider]";
import { upsertAuthenticatedUser } from "../lib/admin-store";
import { consumeOAuthState } from "../lib/oauth-state";
import { SESSION_COOKIE, type AuthProvider } from "../lib/auth";

vi.mock("../lib/admin-store", () => ({ upsertAuthenticatedUser: vi.fn() }));
vi.mock("../lib/oauth-state", () => ({
  consumeOAuthState: vi.fn(), clearOAuthCookie: () => "synthetic-oauth=; Max-Age=0"
}));

const marker = "synthetic-private-provider-detail";
const env = { AUTH_COOKIE_SECRET: "synthetic-session-secret",
  GOOGLE_CLIENT_ID: "synthetic-client", GOOGLE_CLIENT_SECRET: "synthetic-client-secret",
  GITHUB_CLIENT_ID: "synthetic-client", GITHUB_CLIENT_SECRET: "synthetic-client-secret" };
const stages = [
  ["google", "https://oauth2.googleapis.com/token"],
  ["google", "https://www.googleapis.com/oauth2/v3/userinfo"],
  ["github", "https://github.com/login/oauth/access_token"],
  ["github", "https://api.github.com/user"],
  ["github", "https://api.github.com/user/emails"]
] as const;
const nativeFetch = globalThis.fetch;
let server: Server | undefined;

function validResponse(url: string) {
  if (url.endsWith("/token") || url.endsWith("/access_token")) return Response.json({ access_token: "synthetic-access-token" });
  if (url.endsWith("/userinfo")) return Response.json({ sub: "fixture", email: "fixture@example.test", email_verified: true });
  if (url.endsWith("/emails")) return Response.json([{ email: "fixture@example.test", primary: true, verified: true }]);
  return Response.json({ id: 123, login: "fixture" });
}

async function callback(provider: AuthProvider) {
  vi.mocked(consumeOAuthState).mockResolvedValue({ provider, nonce: "synthetic-nonce", returnTo: "/admin", expiresAt: Date.now() + 60000 });
  return onRequestGet({ request: new Request(`https://gateway.test/api/auth/callback/${provider}?code=synthetic-code&state=fixture`),
    env, params: { provider } });
}

function refused(response: Response, provider: AuthProvider) {
  expect(response.status).toBe(302);
  expect(response.headers.get("Location")).toContain("error=oauth_failed");
  expect(response.headers.get("Set-Cookie")).not.toContain(SESSION_COOKIE + "=");
  expect(response.headers.get("Set-Cookie")).toContain("Max-Age=0");
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(upsertAuthenticatedUser).not.toHaveBeenCalled();
  expect(console.error).toHaveBeenCalledWith(JSON.stringify({ event: "oauth_callback_failed", provider }));
  expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(marker);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(upsertAuthenticatedUser).mockResolvedValue({ persisted: true, storageBinding: "DB", role: "member" });
});
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals(); vi.restoreAllMocks();
  if (server) {
    const closing = server;
    server = undefined;
    await new Promise<void>((resolve, reject) => {
      closing.close(error => error ? reject(error) : resolve());
      closing.closeAllConnections();
    });
  }
});

describe("OAuth provider transport confidentiality", () => {
  it.each(stages)("bounds the streamed %s response at %s even without a length header", async (provider, target) => {
    const oversized = " ".repeat(256 * 1024) + await validResponse(target).text();
    const send = vi.fn(async (input: string | URL | Request) =>
      String(input) === target ? new Response(oversized) : validResponse(String(input)));
    vi.stubGlobal("fetch", send);
    refused(await callback(provider), provider);
    expect(send.mock.calls.at(-1)?.[0]).toBe(target);
  });

  it.each(stages)("rejects a declared oversized %s response at %s before reading", async (provider, target) => {
    const response = validResponse(target);
    response.headers.set("Content-Length", String(256 * 1024 + 1));
    const cancel = vi.spyOn(response.body!, "cancel");
    const read = vi.spyOn(response.body!, "getReader");
    vi.stubGlobal("fetch", async (input: string | URL | Request) =>
      String(input) === target ? response : validResponse(String(input)));
    refused(await callback(provider), provider);
    expect(read).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each(stages)("times out delayed %s headers at %s and ignores their late arrival", async (provider, target) => {
    vi.useFakeTimers();
    let arrive!: (response: Response) => void;
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const late = new Promise<Response>(resolve => { arrive = resolve; });
    const send = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>(async input => {
      if (String(input) === target) { entered(); return late; }
      return validResponse(String(input));
    });
    vi.stubGlobal("fetch", send);
    let settled = false;
    const pending = callback(provider).then(response => { settled = true; return response; });
    await ready;
    await vi.advanceTimersByTimeAsync(15_000);
    const stoppedAtDeadline = settled;
    arrive(validResponse(target));
    const response = await pending;
    expect(stoppedAtDeadline).toBe(true);
    refused(response, provider);
    expect(send.mock.calls.at(-1)?.[0]).toBe(target);
    expect(send.mock.calls.at(-1)?.[1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(stages)("times out a stalled %s body at %s without waiting for cancellation", async (provider, target) => {
    vi.useFakeTimers();
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; }, cancel }));
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const send = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>(async input => {
      if (String(input) === target) { entered(); return response; }
      return validResponse(String(input));
    });
    vi.stubGlobal("fetch", send);
    let settled = false;
    const pending = callback(provider).then(result => { settled = true; return result; });
    await ready;
    await vi.advanceTimersByTimeAsync(15_000);
    const stoppedAtDeadline = settled;
    if (!stoppedAtDeadline) stream.error(new Error(marker));
    const result = await pending;
    expect(stoppedAtDeadline).toBe(true);
    refused(result, provider);
    expect(cancel).toHaveBeenCalledOnce();
    expect(send.mock.calls.at(-1)?.[1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(stages)("does not log a %s transport error at %s", async (provider, target) => {
    const send = vi.fn(async (input: string | URL | Request) => {
      if (String(input) === target) throw new Error(marker);
      return validResponse(String(input));
    });
    vi.stubGlobal("fetch", send);
    refused(await callback(provider), provider);
    expect(send.mock.calls.at(-1)?.[0]).toBe(target);
  });

  it.each(stages)("does not log a malformed %s response at %s", async (provider, target) => {
    vi.stubGlobal("fetch", async (input: string | URL | Request) =>
      String(input) === target ? new Response(marker) : validResponse(String(input)));
    refused(await callback(provider), provider);
  });

  it.each(stages)("refuses a %s redirect response without parsing its body at %s", async (provider, target) => {
    const response = new Response(marker, { status: 307, headers: { Location: "https://untrusted.example.test/collect" } });
    const parse = vi.spyOn(response, "json");
    const cancel = vi.spyOn(response.body!, "cancel");
    const send = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>(async input =>
      String(input) === target ? response : validResponse(String(input)));
    vi.stubGlobal("fetch", send);
    refused(await callback(provider), provider);
    expect(parse).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    expect(send.mock.calls.at(-1)?.[1]?.redirect).toBe("manual");
  });

  it.each([301, 302, 303, 308, 400, 401, 403, 429, 500, 503])("discards status %s before parsing its body", async status => {
    const response = new Response(marker, { status });
    const parse = vi.spyOn(response, "json");
    const cancel = vi.spyOn(response.body!, "cancel").mockRejectedValue(new Error(marker));
    const send = vi.fn(async () => response);
    vi.stubGlobal("fetch", send);
    refused(await callback("google"), "google");
    expect(parse).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledOnce();
  });

  it.each(["google", "github"] as const)("keeps the successful %s exchange on fixed endpoints", async provider => {
    const send = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>(async input => validResponse(String(input)));
    vi.stubGlobal("fetch", send);
    const response = await callback(provider);
    expect(response.headers.get("Location")).toBe("https://gateway.test/admin?login=success");
    expect(response.headers.get("Set-Cookie")).toContain(SESSION_COOKIE + "=");
    expect(upsertAuthenticatedUser).toHaveBeenCalledOnce();
    expect(send.mock.calls.map(([url]) => url)).toEqual(stages.filter(([p]) => p === provider).map(([, url]) => url));
    for (const [, init] of send.mock.calls) expect(init?.redirect).toBe("manual");
    expect(console.error).not.toHaveBeenCalled();
  });

  it("does not forward the token POST to a redirect target on a loopback server", async () => {
    let redirected = 0;
    server = createServer((request, response) => {
      request.resume();
      if (request.url === "/token") {
        response.writeHead(307, { Location: "/collect" }); response.end();
      } else {
        redirected++;
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ access_token: "synthetic-access-token" }));
      }
    });
    await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected loopback address");
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) === stages[0][1]) return nativeFetch(`http://127.0.0.1:${address.port}/token`, init);
      return validResponse(String(input));
    });
    const response = await callback("google");
    expect(redirected).toBe(0);
    refused(response, "google");
  });
});
