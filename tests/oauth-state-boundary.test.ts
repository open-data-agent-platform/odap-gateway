import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { jobDatabase, jobSqlite } from "./fixtures/job-sqlite";
import { startOAuthLogin } from "./fixtures/oauth-flow";
import worker from "../worker";
import { signAuthPayload, verifyAuthPayload, type OAuthState } from "../lib/auth";
import { sha256Text } from "../lib/control-objects";

let dir: string, file: string, baseline: string;
const db = jobDatabase(() => file);
const env = {AUTH_COOKIE_SECRET:"synthetic-state-binding",GOOGLE_CLIENT_ID:"fixture",GOOGLE_CLIENT_SECRET:"fixture-only",
  GITHUB_CLIENT_ID:"fixture",GITHUB_CLIENT_SECRET:"fixture-only",DB:db,
  ASSETS:{fetch:async () => {throw new Error("Unexpected asset request");}}};
const exchange = vi.fn(async () => Response.json({error:"synthetic-provider-failure"},{status:400}));
const callback = (request: Request) => worker.fetch(request,env,{waitUntil:() => undefined});

describe("browser-bound, single-use OAuth state", () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(),"odap-login-state-"));
    file = baseline = join(dir,"baseline.sqlite");
    await jobSqlite(file,"apply-oauth-states");
  });
  beforeEach(async () => {
    file = join(dir,"case.sqlite"); await copyFile(baseline,file);
    exchange.mockClear(); vi.stubGlobal("fetch",exchange);
    vi.spyOn(console,"error").mockImplementation(() => {});
  });
  afterEach(() => {vi.unstubAllGlobals();vi.restoreAllMocks();});
  afterAll(async () => {if (dir) await rm(dir,{recursive:true,force:true});});

  it("refuses a callback moved from browser A to browser B before token exchange",async () => {
    const a = await startOAuthLogin(env), b = await startOAuthLogin(env);
    const response = await callback(new Request(a.url,{headers:{Cookie:b.cookie}}));
    expect(response.headers.get("Location")).toContain("error=invalid_state");
    expect(exchange).not.toHaveBeenCalled();
    expect((await callback(a.request())).headers.get("Location")).toContain("error=oauth_failed");
    expect(exchange).toHaveBeenCalledTimes(1);
  });

  it("consumes a valid state once even when the provider fails and the old cookie is replayed",async () => {
    const flow = await startOAuthLogin(env);
    expect((await callback(flow.request())).headers.get("Location")).toContain("error=oauth_failed");
    const replay = await callback(flow.request());
    expect(replay.headers.get("Location")).toContain("error=invalid_state");
    expect(exchange).toHaveBeenCalledTimes(1);
  });

  it("stores only challenge digests and sets a host-only, HttpOnly, short-lived cookie",async () => {
    const flow = await startOAuthLogin(env);
    const cookie = flow.response.headers.get("Set-Cookie")!;
    expect(cookie).toMatch(/^__Host-odap_gateway_oauth=[0-9a-f]{64};/);
    for (const part of ["Path=/","Max-Age=600","HttpOnly","SameSite=Lax","Secure"]) expect(cookie).toContain(part);
    expect(cookie).not.toContain("Domain=");
    const rawSecret = flow.cookie.split("=")[1];
    const stored = await jobSqlite(file,"readonly-first","SELECT * FROM oauth_login_states");
    expect(stored).toMatchObject({origin:"https://gateway.test",provider:"google",
      state_digest:await sha256Text("oauth-state:"+flow.state),
      browser_digest:await sha256Text("oauth-browser:"+rawSecret)});
    expect(JSON.stringify(stored)).not.toContain(rawSecret);
    expect(flow.response.headers.get("Location")).not.toContain(rawSecret);
  });

  it.each(["missing","malformed","duplicate","origin","provider","signature","extra-segment"])(
    "rejects %s binding without consuming the valid challenge",async variant => {
      const flow = await startOAuthLogin(env);
      const url = new URL(flow.url);
      let cookie = flow.cookie;
      if (variant === "missing") cookie = "";
      if (variant === "malformed") cookie = cookie.split("=")[0]+"=%E0%A4%A";
      if (variant === "duplicate") cookie += "; "+cookie;
      if (variant === "origin") url.hostname = "another.test";
      if (variant === "provider") url.pathname = "/api/auth/callback/github";
      if (variant === "signature") url.searchParams.set("state",flow.state.slice(0,-1)+"!");
      if (variant === "extra-segment") url.searchParams.set("state",flow.state+".suffix");
      const response = await callback(new Request(url,{headers:{Cookie:cookie}}));
      expect(response.headers.get("Location")).toContain("error=invalid_state");
      expect(response.headers.get("Set-Cookie")).toBeNull();
      expect(exchange).not.toHaveBeenCalled();
      expect((await callback(flow.request())).headers.get("Location")).toContain("error=oauth_failed");
      expect(exchange).toHaveBeenCalledTimes(1);
    },15000);

  it("rejects an expired state without contacting a provider",async () => {
    const flow = await startOAuthLogin(env);
    const payload = await verifyAuthPayload<OAuthState>(flow.state,env.AUTH_COOKIE_SECRET);
    vi.spyOn(Date,"now").mockReturnValue(payload!.expiresAt);
    expect((await callback(flow.request())).headers.get("Location")).toContain("error=invalid_state");
    expect(exchange).not.toHaveBeenCalled();
  });

  it("does not accept an identity session as OAuth state",async () => {
    const flow = await startOAuthLogin(env);
    const token = await signAuthPayload({provider:"google",providerId:"fixture",email:"fixture@example.test",
      name:"Fixture",role:"admin",expiresAt:Date.now()+60000},env.AUTH_COOKIE_SECRET);
    const url = new URL(flow.url);
    url.searchParams.set("state",token);
    expect((await callback(new Request(url,{headers:{Cookie:flow.cookie}}))).headers.get("Location"))
      .toContain("error=invalid_state");
    expect(exchange).not.toHaveBeenCalled();
  });

  it("atomically admits one of two concurrent callbacks",async () => {
    const flow = await startOAuthLogin(env);
    const results = await Promise.all([callback(flow.request()),callback(flow.request())]);
    expect(results.map(r => new URL(r.headers.get("Location")!).searchParams.get("error")).sort())
      .toEqual(["invalid_state","oauth_failed"]);
    expect(exchange).toHaveBeenCalledTimes(1);
  },15000);

  it("consumes a provider denial and clears the binding, without a token exchange",async () => {
    const flow = await startOAuthLogin(env);
    const url = new URL(flow.url);
    url.searchParams.delete("code");
    url.searchParams.set("error","access_denied");
    const denied = await callback(new Request(url,{headers:{Cookie:flow.cookie}}));
    expect(denied.headers.get("Location")).toContain("error=oauth_denied");
    expect(denied.headers.get("Set-Cookie")).toContain("__Host-odap_gateway_oauth=; Path=/; Max-Age=0;");
    expect((await callback(flow.request())).headers.get("Location")).toContain("error=invalid_state");
    expect(exchange).not.toHaveBeenCalled();
  });

  it("fails closed when storage is absent or fails, before contacting the provider",async () => {
    const flow = await startOAuthLogin(env);
    for (const DB of [undefined,{prepare() {throw new Error("sensitive");}}]) {
      for (const request of [new Request("https://gateway.test/api/auth/start/google"),flow.request()]) {
        const response = await worker.fetch(request,{...env,DB},{waitUntil:() => undefined});
        expect(response.headers.get("Location")).toContain("error=oauth_state_unavailable");
        expect(response.headers.get("Set-Cookie")).toBeNull();
      }
    }
    expect(exchange).not.toHaveBeenCalled();
  });

  it("supports HTTP only on loopback and neutralizes backslash return targets",async () => {
    const local = await worker.fetch(new Request("http://localhost:8787/api/auth/start/google?returnTo="+
      encodeURIComponent("/\\outside.test")) ,env,{waitUntil:() => undefined});
    expect(local.headers.get("Set-Cookie")).toContain("odap_gateway_oauth_local=");
    const state = new URL(local.headers.get("Location")!).searchParams.get("state")!;
    expect(await verifyAuthPayload<OAuthState>(state,env.AUTH_COOKIE_SECRET)).toMatchObject({returnTo:"/"});
    const unsafe = await worker.fetch(new Request("http://gateway.test/api/auth/start/google"),env,{waitUntil:() => undefined});
    expect(unsafe.headers.get("Location")).toContain("error=oauth_state_unavailable");
    expect(exchange).not.toHaveBeenCalled();
  });
});
