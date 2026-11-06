import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionCookie, signAuthPayload } from "../lib/auth";
import { ensureAdminSchema } from "../lib/admin-store";
import { onRequest as pages } from "../functions/_middleware";
import { jobDatabase, jobTransactionalDatabase, jobSqlite } from "./fixtures/job-sqlite";
import worker from "../worker";
import { type D1Database } from "../lib/d1";

const secret = "synthetic-admin-revocation";
let dir: string, file: string;
const db = jobTransactionalDatabase(() => file);
const sql = (query: string, params: string[] = []) => jobSqlite(file,"run",query,params);
const assets = vi.fn(async () => new Response("private"));
const next = vi.fn(async () => new Response("private"));
const env = {AUTH_COOKIE_SECRET:secret,DB:db,ASSETS:{fetch:assets}};
const cookie = (id: string, provider: "google" | "github" = "google") => signAuthPayload({provider,providerId:id,
  email:id+"@example.test",name:id,role:"admin",expiresAt:Date.now()+60000},secret).then(t => createSessionCookie(t,true));
const request = (path: string, token: string, role?: string) => new Request("https://gateway.test"+path,{
  method:role ? "PATCH" : "GET", headers:{Cookie:token,...(role ? {Origin:"https://gateway.test","Content-Type":"application/json"} : {})},...(role ? {body:JSON.stringify({role})} : {})
});
const fetchLocal = (req: Request, bindings: Parameters<typeof worker.fetch>[1] = env) =>
  worker.fetch(req,bindings,{waitUntil:() => undefined});

describe("current legacy administrator authority", () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(),"odap-admin-revocation-"));
    file = join(dir,"local.sqlite");
    await ensureAdminSchema(db);
    for (const id of ["first","second","target"])
      await sql(`INSERT INTO users(id,provider,provider_id,email,name,role,last_login_at,created_at,updated_at)
        VALUES (?,'google',?,?,?,?,'synthetic','synthetic','synthetic')`,
      ["google:"+id,id,id+"@example.test",id,id === "target" ? "member" : "admin"]);
  },20000);
  beforeEach(async () => {
    await sql(`INSERT INTO users(id,provider,provider_id,email,name,role,last_login_at,created_at,updated_at)
      VALUES ('google:second','google','second','second@example.test','second','member','synthetic','synthetic','synthetic')
      ON CONFLICT(id) DO UPDATE SET role='member'`);
  });
  afterAll(async () => { if (dir) await rm(dir,{recursive:true,force:true}); });

  it("rejects a demoted administrator's existing cookie before another role mutation",async () => {
    const first = await cookie("first"), second = await cookie("second");
    await sql("UPDATE users SET role='admin' WHERE id='google:second'");
    expect((await fetchLocal(request("/api/admin/users/google%3Asecond",first,"member"))).status).toBe(200);
    const before = await readFile(file);
    const response = await fetchLocal(request("/api/admin/users/google%3Atarget",second,"admin"));
    const target = await jobSqlite(file,"readonly-first","SELECT role FROM users WHERE id='google:target'");
    expect({status:response.status,target}).toEqual({status:403,target:{role:"member"}});
    expect(await response.json()).toMatchObject({code:"admin_required"});
    expect(await readFile(file)).toEqual(before);
  },20000);

  it("uses the same current authority for Worker and Pages private assets and admin health",async () => {
    const token = await cookie("second");
    assets.mockClear(); next.mockClear();
    expect((await fetchLocal(request("/admin",token))).status).toBe(403);
    expect((await pages({request:request("/admin",token),env,next})).status).toBe(403);
    expect((await fetchLocal(request("/api/admin/health",token))).status).toBe(403);
    expect(assets).not.toHaveBeenCalled(); expect(next).not.toHaveBeenCalled();
    expect((await fetchLocal(request("/api/admin/health",await cookie("first")))).status).toBe(200);
  });

  it("binds authority to provider subject, not a matching email or cookie role",async () => {
    expect((await fetchLocal(request("/api/admin/health",await cookie("first","github")))).status).toBe(403);
    expect((await fetchLocal(request("/api/admin/health",await cookie("absent")))).status).toBe(403);
  });

  it("fails closed without authority storage and never falls back from a failed preferred binding",async () => {
    const broken: D1Database = {prepare() { throw new Error("sensitive-storage-failure"); }};
    const missingSchema = join(dir,"no-users.sqlite");
    await jobSqlite(missingSchema,"run","CREATE TABLE unrelated(id TEXT)");
    const token = await cookie("first");
    for (const bindings of [
      {AUTH_COOKIE_SECRET:secret,ADMIN_EMAILS:"first@example.test",ASSETS:env.ASSETS},
      {...env,ODAP_GATEWAY_DB:broken,ADMIN_EMAILS:"first@example.test"},
      {...env,DB:jobDatabase(() => missingSchema)}
    ]) {
      const before = await readFile(file);
      const response = await fetchLocal(request("/api/admin/users/google%3Atarget",token,"admin"),bindings);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ok:false,code:"admin_authority_unavailable",
        message:"Current administrator authority could not be verified."});
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(await readFile(file)).toEqual(before);
      assets.mockClear(); next.mockClear();
      expect((await fetchLocal(request("/admin",token),bindings)).status).toBe(503);
      expect((await pages({request:request("/admin",token),env:bindings,next})).status).toBe(503);
      expect(assets).not.toHaveBeenCalled(); expect(next).not.toHaveBeenCalled();
    }
    expect(await jobSqlite(missingSchema,"readonly-first","SELECT count(*) n FROM sqlite_master WHERE name='users'")).toEqual({n:0});
  });

  it("denies a removed user even when a stale cookie and email allowlist still name an admin",async () => {
    const token = await cookie("second");
    await sql("DELETE FROM users WHERE id='google:second'");
    const response = await fetchLocal(request("/api/admin/health",token),{...env,ADMIN_EMAILS:"second@example.test"});
    expect(response.status).toBe(403);
  });
});
