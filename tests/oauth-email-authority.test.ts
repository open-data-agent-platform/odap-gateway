import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_COOKIE, readCookie, verifyAuthPayload, type AuthProvider, type AuthSession } from "../lib/auth";
import { startOAuthLogin } from "./fixtures/oauth-flow";
import { ensureAdminSchema } from "../lib/admin-store";
import { jobTransactionalDatabase, jobSqlite } from "./fixtures/job-sqlite";
import worker from "../worker";

const secret = "synthetic-verified-contact-session";
let dir: string, file: string, baseline: string;
let googleProfile: Record<string, unknown>;
let githubProfile: Record<string, unknown>;
let emails: unknown, emailStatus: number;
const calls: string[] = [];
const base = jobTransactionalDatabase(() => file);
const db = {...base,prepare: vi.fn((query: string) => base.prepare(query))};
const env = {AUTH_COOKIE_SECRET:secret,GOOGLE_CLIENT_ID:"fixture",GOOGLE_CLIENT_SECRET:"fixture-only",
  GITHUB_CLIENT_ID:"fixture",GITHUB_CLIENT_SECRET:"fixture-only",ADMIN_EMAILS:"admin@example.test",
  DB:db,ASSETS:{fetch:async () => {throw new Error("Unexpected asset request");}}};
async function login(provider: AuthProvider) {
  const flow = await startOAuthLogin(env,provider);
  db.prepare.mockClear();
  return worker.fetch(flow.request(),env,
    {waitUntil:() => undefined});
}
async function session(response: Response) {
  return verifyAuthPayload<AuthSession>(readCookie(response.headers.get("Set-Cookie"),SESSION_COOKIE),secret);
}
async function refused(provider: AuthProvider) {
  const response = await login(provider);
  expect(response.status).toBe(302);
  expect(await session(response)).toBeNull();
  expect(response.headers.get("Location")).toContain("error=oauth_failed");
  expect(db.prepare).toHaveBeenCalledTimes(1);
  expect(db.prepare.mock.calls[0][0]).toMatch(/^DELETE FROM oauth_login_states /);
  expect(await jobSqlite(file,"readonly-first",
    "SELECT (SELECT count(*) FROM users) users, (SELECT count(*) FROM audit_events) events")).toEqual({users:0,events:0});
}

describe("verified provider email before account creation", () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(),"odap-verified-email-"));
    file = baseline = join(dir,"baseline.sqlite");
    await ensureAdminSchema(db);
    await jobSqlite(file,"apply-oauth-states");
  },20000);
  beforeEach(async () => {
    file = join(dir,"case.sqlite"); await copyFile(baseline,file);
    googleProfile = {sub:"google-new",email:"admin@example.test",email_verified:true,name:"Synthetic"};
    githubProfile = {id:123,login:"fixture",email:"admin@example.test"};
    emails = [{email:"verified@example.test",primary:true,verified:true}];
    emailStatus = 200; calls.length = 0; db.prepare.mockClear();
    vi.spyOn(console,"error").mockImplementation(() => {});
    vi.stubGlobal("fetch",async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      if (url === "https://oauth2.googleapis.com/token" || url === "https://github.com/login/oauth/access_token")
        return Response.json({access_token:"fixture-token"});
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer fixture-token");
      if (url === "https://www.googleapis.com/oauth2/v3/userinfo") return Response.json(googleProfile);
      if (url === "https://api.github.com/user") return Response.json(githubProfile);
      if (url === "https://api.github.com/user/emails") return Response.json(emails,{status:emailStatus});
      throw new Error("Unexpected outbound request");
    });
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
  afterAll(async () => { if (dir) await rm(dir,{recursive:true,force:true}); });

  it.each([undefined,false,null,"true",1])("rejects Google email_verified=%s before any user write",async flag => {
    googleProfile.email_verified = flag;
    await refused("google");
  },15000);

  it("ignores an allowlisted GitHub public email in favor of the verified primary contact",async () => {
    emails = [{email:"admin@example.test",primary:false,verified:true},
      {email:"verified@example.test",primary:true,verified:true}];
    const response = await login("github");
    expect(await session(response)).toMatchObject({provider:"github",providerId:"123",email:"verified@example.test",role:"member"});
    expect(calls).toContain("https://api.github.com/user/emails");
    expect(await jobSqlite(file,"readonly-first","SELECT id,email,role FROM users")).toEqual({
      id:"github:123",email:"verified@example.test",role:"member"
    });
  },15000);

  it.each([undefined,null,"","   ","bad contact@example.test",42])("rejects unusable verified Google email %s",async email => {
    googleProfile.email = email;
    await refused("google");
  });

  const invalidPrimaries: [string,unknown][] = [
    ["empty list",[]],
    ["malformed list",{email:"admin@example.test",primary:true,verified:true}],
    ["unverified",[{email:"admin@example.test",primary:true,verified:false}]],
    ["string verification",[{email:"admin@example.test",primary:true,verified:"true"}]],
    ["string primary",[{email:"admin@example.test",primary:"true",verified:true}]],
    ["nonprimary only",[{email:"admin@example.test",primary:false,verified:true}]],
    ["blank address",[{email:"  ",primary:true,verified:true}]],
    ["missing address",[{primary:true,verified:true}]],
    ["multiple primaries",[{email:"admin@example.test",primary:true,verified:true},
      {email:"other@example.test",primary:true,verified:true}]]
  ];
  it.each(invalidPrimaries)("rejects GitHub %s without using the public email",async (_label,data) => {
    emails = data;
    await refused("github");
    expect(calls).toContain("https://api.github.com/user/emails");
  });

  it.each([403,500])("does not fall back when verified-email retrieval returns %s",async status => {
    emailStatus = status;
    await refused("github");
  });

  it("does not construct a noreply address when no verified primary exists",async () => {
    githubProfile.email = null; emails = [];
    await refused("github");
  });

  it("uses a verified, normalized Google contact for initial role bootstrap",async () => {
    googleProfile.email = " Admin@Example.Test ";
    const response = await login("google");
    expect(await session(response)).toMatchObject({providerId:"google-new",email:"admin@example.test",role:"admin"});
    expect(await jobSqlite(file,"readonly-first","SELECT id,email,role FROM users")).toEqual({
      id:"google:google-new",email:"admin@example.test",role:"admin"
    });
  },15000);

  it("uses the verified primary GitHub contact even when the public contact is different",async () => {
    githubProfile.email = "public@example.test";
    emails = [{email:" ADMIN@EXAMPLE.TEST ",primary:true,verified:true}];
    const response = await login("github");
    expect(await session(response)).toMatchObject({providerId:"123",email:"admin@example.test",role:"admin"});
    expect(await jobSqlite(file,"readonly-first","SELECT id,email,role FROM users")).toEqual({
      id:"github:123",email:"admin@example.test",role:"admin"
    });
  },15000);
});
