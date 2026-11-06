import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_COOKIE, readCookie, signAuthPayload } from "../lib/auth";
import { onRequest as pagesMiddleware } from "../functions/_middleware";
import worker from "../worker";

const secret = "synthetic-cookie-boundary";
let validCookie: string;
const prepare = vi.fn(() => { throw new Error("Unexpected authority lookup"); });
const asset = vi.fn(async () => new Response("private asset"));
const outbound = vi.fn(async () => { throw new Error("Unexpected provider request"); });
const next = vi.fn(async () => new Response("private page"));
const background = vi.fn();
const env = {AUTH_COOKIE_SECRET:secret,DB:{prepare},ASSETS:{fetch:asset}};

beforeAll(async () => {
  validCookie = SESSION_COOKIE + "=" + await signAuthPayload({
    provider:"google",providerId:"fixture",email:"fixture@example.test",name:"Fixture",
    role:"admin",expiresAt:Date.now()+600000
  },secret);
});
beforeEach(() => {
  for (const mock of [prepare,asset,outbound,next,background]) mock.mockClear();
  vi.stubGlobal("fetch",outbound);
  vi.spyOn(console,"error").mockImplementation(() => {});
});
afterEach(() => {vi.unstubAllGlobals();vi.restoreAllMocks();});

async function anonymous(cookie: string) {
  for (const [path,method,status] of [
    ["/api/auth/session","GET",200],
    ["/api/admin/health","GET",401],
    ["/api/control/tenant-a/evidence-coverage","GET",401],
    ["/api/control/tenant-a/proposals","POST",401],
    ["/admin","GET",302]
  ] as const) {
    const request = new Request("https://gateway.test"+path,{
      method,headers:{Cookie:cookie,Origin:"https://gateway.test","Content-Type":"application/json"},
      ...(method === "POST" ? {body:"not-json"} : {})
    });
    const response = await worker.fetch(request,env,{waitUntil:background});
    expect(response.status,path).toBe(status);
    if (path === "/api/auth/session") expect(await response.json()).toMatchObject({authenticated:false,user:null});
    else if (status === 401) expect(await response.json()).toMatchObject({code:"unauthenticated"});
    else expect(response.headers.get("Location")).toContain("/login");
  }
  const pages = await pagesMiddleware({request:new Request("https://gateway.test/admin",{
    headers:{Cookie:cookie}}),env,next});
  expect(pages.status).toBe(302);
  expect(pages.headers.get("Location")).toContain("/login");
  for (const mock of [prepare,asset,outbound,next,background]) expect(mock).not.toHaveBeenCalled();
  expect(console.error).not.toHaveBeenCalled();
}

describe("untrusted identity cookie parsing", () => {
  it.each(["%","%A","%ZZ","%E0%A4%A","%C0%AF"])("refuses malformed encoding %s as unauthenticated",async value => {
    await anonymous(SESSION_COOKIE+"="+value);
  });

  it.each(["valid-first","valid-last","identical"])("refuses ambiguous duplicate cookies: %s",async order => {
    const invalid = SESSION_COOKIE+"=not-a-token";
    await anonymous(order === "valid-first" ? validCookie+"; "+invalid :
      order === "valid-last" ? invalid+"; "+validCookie : validCookie+"; "+validCookie);
  });

  it("does not let an unrelated malformed cookie discard an unambiguous identity",async () => {
    const response = await worker.fetch(new Request("https://gateway.test/api/auth/session",{
      headers:{Cookie:"other=%E0%A4%A; "+SESSION_COOKIE+"_suffix=ignored; "+validCookie}
    }),env,{waitUntil:background});
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({authenticated:true,user:{provider:"google",email:"fixture@example.test"}});
    expect(prepare).not.toHaveBeenCalled();
  });

  it("retains exact cookie-name matching and percent decoding",() => {
    expect(readCookie("other=ignored; value=hello%20world","value")).toBe("hello world");
    expect(readCookie("value_suffix=wrong","value")).toBeUndefined();
    expect(readCookie(null,"value")).toBeUndefined();
  });
});
