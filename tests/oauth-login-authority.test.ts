import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_COOKIE, readCookie, verifyAuthPayload, type AuthProvider, type AuthSession } from "../lib/auth";
import { startOAuthLogin } from "./fixtures/oauth-flow";
import { ensureAdminSchema } from "../lib/admin-store";
import { jobTransactionalDatabase, jobSqlite } from "./fixtures/job-sqlite";
import worker from "../worker";

const secret = "synthetic-login-authority";
let dir: string, file: string, baseline: string;
let subject = "known", email = "known@example.test";
let beforeUserWrite: (() => Promise<unknown>) | null = null;
const base = jobTransactionalDatabase(() => file);
const db = {...base,batch: async (statements: Parameters<NonNullable<typeof base.batch>>[0]) => {
  const hook = beforeUserWrite;
  beforeUserWrite = null;
  await hook?.();
  return base.batch!(statements);
}};
const env = {AUTH_COOKIE_SECRET:secret,GOOGLE_CLIENT_ID:"fixture-client",GOOGLE_CLIENT_SECRET:"fixture-only",
  GITHUB_CLIENT_ID:"fixture-client",GITHUB_CLIENT_SECRET:"fixture-only",ADMIN_EMAILS:"known@example.test,new@example.test",
  DB:db,ASSETS:{fetch:async () => {throw new Error("Unexpected asset request");}}};
const sql = (q: string, p: string[] = []) => jobSqlite(file,"run",q,p);
const stored = () => jobSqlite(file,"readonly-first","SELECT * FROM users WHERE id='google:known'");
const fetchLocal = (r: Request, bindings: Parameters<typeof worker.fetch>[1] = env) =>
  worker.fetch(r,bindings,{waitUntil:() => undefined});
async function login(provider: AuthProvider = "google", bindings: Parameters<typeof worker.fetch>[1] = env) {
  const flow = await startOAuthLogin(env, provider);
  return fetchLocal(flow.request(),bindings);
}
async function session(response: Response) {
  const token = readCookie(response.headers.get("Set-Cookie"),SESSION_COOKIE);
  return verifyAuthPayload<AuthSession>(token,secret);
}

describe("persisted OAuth identity and authority", () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(),"odap-login-authority-"));
    file = baseline = join(dir,"baseline.sqlite");
    await ensureAdminSchema(db);
    await jobSqlite(file,"apply-oauth-states");
    await sql(`INSERT INTO users(id,provider,provider_id,email,name,role,last_login_at,created_at,updated_at)
      VALUES ('google:known','google','known','known@example.test','Known','member','synthetic','synthetic','synthetic')`);
  },20000);
  beforeEach(async () => {
    file = join(dir,"case.sqlite"); await copyFile(baseline,file);
    subject = "known"; email = "known@example.test";
    beforeUserWrite = null;
    vi.spyOn(console,"error").mockImplementation(() => {});
    vi.stubGlobal("fetch",async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "https://oauth2.googleapis.com/token" || url === "https://github.com/login/oauth/access_token")
        return Response.json({access_token:"fixture-token"});
      if (url === "https://www.googleapis.com/oauth2/v3/userinfo")
        return Response.json({sub:subject,email,email_verified:true,name:"Synthetic"});
      if (url === "https://api.github.com/user") return Response.json({id:subject,login:"fixture",email});
      if (url === "https://api.github.com/user/emails") return Response.json([{email,primary:true,verified:true}]);
      throw new Error("Unexpected outbound request");
    });
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
  afterAll(async () => { if (dir) await rm(dir,{recursive:true,force:true}); });

  it("does not restore a demoted role through a new allowlisted login",async () => {
    const response = await login();
    expect(response.status).toBe(302);
    expect(await session(response)).toMatchObject({provider:"google",providerId:"known",role:"member"});
    expect(await stored()).toMatchObject({role:"member",provider_id:"known",created_at:"synthetic"});
    const health = await fetchLocal(new Request("https://gateway.test/api/admin/health",{
      headers:{Cookie:response.headers.get("Set-Cookie")!}
    }));
    expect(health.status).toBe(403);
    expect(await jobSqlite(file,"readonly-first","SELECT json_extract(metadata_json,'$.role') role FROM audit_events WHERE action='auth.login'"))
      .toEqual({role:"member"});
  },15000);

  it.each(["google","github"] as const)("does not transfer the same email to a different %s subject",async provider => {
    await sql("UPDATE users SET role='admin' WHERE id='google:known'");
    const before = await stored();
    subject = "replacement";
    const response = await login(provider);
    expect(await session(response)).toBeNull();
    expect(response.headers.get("Location")).toContain("error=auth_user_persist_failed");
    expect(await stored()).toEqual(before);
    expect(await jobSqlite(file,"readonly-first","SELECT count(*) n FROM audit_events WHERE action='auth.login'")).toEqual({n:0});
  },15000);

  it("bootstraps only a new subject and preserves the stored role on later logins",async () => {
    subject = "new"; email = "new@example.test";
    const first = await login();
    expect(await session(first)).toMatchObject({providerId:"new",role:"admin"});
    const row = await jobSqlite(file,"readonly-first","SELECT created_at FROM users WHERE id='google:new'");
    email = "renamed@example.test";
    const second = await login("google",{...env,ADMIN_EMAILS:""});
    expect(await session(second)).toMatchObject({providerId:"new",email,role:"admin"});
    expect(await jobSqlite(file,"readonly-first","SELECT provider,provider_id,email,role,created_at FROM users WHERE id='google:new'"))
      .toEqual({provider:"google",provider_id:"new",email,role:"admin",created_at:row.created_at});
  },40000);

  it("does not overwrite a demotion committed immediately before the login write",async () => {
    await sql("UPDATE users SET role='admin' WHERE id='google:known'");
    beforeUserWrite = () => sql("UPDATE users SET role='member' WHERE id='google:known'");
    const response = await login();
    expect(await session(response)).toMatchObject({role:"member"});
    expect(await stored()).toMatchObject({role:"member"});
    expect(beforeUserWrite).toBeNull();
  },15000);

  it("rejects an inconsistent legacy identity row without repairing it during login",async () => {
    await sql("UPDATE users SET provider_id='different',role='admin' WHERE id='google:known'");
    const before = await stored();
    const response = await login();
    expect(await session(response)).toBeNull();
    expect(response.headers.get("Location")).toContain("error=auth_user_persist_failed");
    expect(await stored()).toEqual(before);
  },15000);

  it.each(["known","new"])("preserves all user data when the %s login audit fails",async id => {
    subject = id; email = `${id}@example.test`;
    const before = await jobSqlite(file,"readonly-first","SELECT * FROM users");
    await sql(`CREATE TRIGGER failed_login_audit BEFORE INSERT ON audit_events
      WHEN NEW.action='auth.login' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END`);
    const response = await login();
    expect(await session(response)).toBeNull();
    expect(response.headers.get("Location")).toContain("error=auth_user_persist_failed");
    expect(await jobSqlite(file,"readonly-first","SELECT count(*) n FROM users")).toEqual({n:1});
    expect(await jobSqlite(file,"readonly-first","SELECT * FROM users")).toEqual(before);
    expect(await jobSqlite(file,"readonly-first","SELECT count(*) n FROM audit_events")).toEqual({n:0});
    expect(await jobSqlite(file,"readonly-first","SELECT count(*) n FROM oauth_login_states")).toEqual({n:0});
  },20000);

  it("does not issue a session or retry after losing the committed login acknowledgment",async () => {
    const batch = vi.spyOn(db,"batch").mockImplementation(async statements => {
      await base.batch!(statements);
      throw new Error("sensitive-acknowledgment-loss");
    });
    const flow = await startOAuthLogin(env);
    const response = await fetchLocal(flow.request());
    expect(await session(response)).toBeNull();
    expect(response.headers.get("Location")).toContain("error=auth_user_persist_failed");
    expect(await stored()).toMatchObject({name:"Synthetic",role:"member"});
    expect(await jobSqlite(file,"readonly-first","SELECT count(*) n FROM audit_events WHERE action='auth.login'"))
      .toEqual({n:1});
    expect((await fetchLocal(flow.request())).headers.get("Location")).toContain("error=invalid_state");
    expect(batch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("sensitive");
  },20000);

  it("fails without a session when the selected storage lacks atomic batch support",async () => {
    const before = await stored();
    const response = await login("google",{...env,DB:{prepare:db.prepare}});
    expect(await session(response)).toBeNull();
    expect(response.headers.get("Location")).toContain("error=auth_user_persist_failed");
    expect(await stored()).toEqual(before);
    expect(await jobSqlite(file,"readonly-first","SELECT count(*) n FROM audit_events")).toEqual({n:0});
  },20000);

  it("does not issue an identity session when storage is absent or a write fails",async () => {
    let index = 0;
    for (const bindings of [
      {...env,DB:undefined},
      {...env,DB:{prepare() {throw new Error("sensitive-storage-detail");}}},
      {...env,DB:{...db,prepare(query: string) {
        if (query.includes("INSERT INTO audit_events")) throw new Error("sensitive-audit-detail");
        return db.prepare(query);
      }}},
      {...env,DB:{...db,batch:async () => [{success:false,results:[]}]}}
    ]) {
      const response = await login("google",bindings);
      expect(await session(response)).toBeNull();
      expect(response.headers.get("Location")).toContain(index++ < 2 ? "error=oauth_state_unavailable" : "error=auth_user_persist_failed");
      expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("sensitive");
    }
  },25000);
});
