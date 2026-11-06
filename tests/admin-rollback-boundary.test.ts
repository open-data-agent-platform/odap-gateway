import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionCookie, signAuthPayload, type AuthRole } from "../lib/auth";
import { jobDatabase, jobSqlite } from "./fixtures/job-sqlite";
import worker from "../worker";

const secret = "synthetic-rollback-session-secret";
let dir: string, file: string;
const base = jobDatabase(() => file);
const prepare = vi.fn((sql: string) => {
  const statement = base.prepare(sql);
  return {...statement, run: <T,>() => statement.bind().run<T>(), first: <T,>() => statement.bind().first<T>()};
});
const outbound = vi.fn(async () => { throw new Error("Outbound access forbidden"); });
const assets = vi.fn(async () => { throw new Error("Unexpected asset request"); });
const pending = vi.fn();

async function post(role: AuthRole | null, mode?: "production" | "demo", storage = true, method = "POST") {
  const cookie = role ? createSessionCookie(await signAuthPayload({provider:"google",providerId:"fixture",
    email:"admin@example.test",name:"Fixture",role,expiresAt:Date.now()+60000},secret),true) : "";
  return worker.fetch(new Request("https://gateway.test/api/admin/rollback?GATEWAY_MODE=demo",{
    method,headers:{Cookie:cookie,"X-Gateway-Mode":"demo","Content-Type":"application/json"},
    ...(method === "POST" ? {body:JSON.stringify({target:"claimed-deployment",queued:true,GATEWAY_MODE:"demo"})} : {})
  }),{AUTH_COOKIE_SECRET:secret,GATEWAY_MODE:mode,...(storage ? {DB:{prepare}} : {}),ASSETS:{fetch:assets}},
  {waitUntil:pending});
}

describe("legacy admin rollback boundary", () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(),"odap-rollback-"));
    file = join(dir,"audit.sqlite");
    await jobSqlite(file,"run",`CREATE TABLE audit_events(id TEXT PRIMARY KEY,actor_email TEXT NOT NULL,
      action TEXT NOT NULL,target TEXT NOT NULL,metadata_json TEXT NOT NULL,created_at TEXT NOT NULL)`);
    await jobSqlite(file,"run","INSERT INTO audit_events VALUES('historical','fixture@example.test','rollback.queued','legacy','{}','synthetic')");
    await jobSqlite(file,"run","CREATE TABLE users(id TEXT PRIMARY KEY,provider TEXT,provider_id TEXT,role TEXT,email TEXT)");
    await jobSqlite(file,"run","INSERT INTO users VALUES('google:fixture','google','fixture','admin','admin@example.test')");
  });
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch",outbound);
  });
  afterEach(() => { vi.unstubAllGlobals(); });
  afterAll(async () => { if (dir) await rm(dir,{recursive:true,force:true}); });

  it.each(["production","demo",undefined] as const)("never claims an operational rollback in %s mode",async mode => {
    const before = await readFile(file);
    const response = await post("admin",mode);
    const body = await response.json();
    const audit = await jobSqlite(file,"readonly-first","SELECT count(*) count FROM audit_events");
    expect({status:response.status,body,auditCount:audit.count}).toEqual({status:501,
      body:{ok:false,code:"rollback_not_supported",message:"Deployment rollback is not implemented. No rollback was queued or executed."},
      auditCount:1});
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await readFile(file)).toEqual(before);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledWith("SELECT role,email FROM users WHERE id=? AND provider=? AND provider_id=?");
    expect(outbound).not.toHaveBeenCalled();
    expect(pending).not.toHaveBeenCalled();
    expect(assets).not.toHaveBeenCalled();
  },20000);

  it("cannot verify current authority without storage", async () => {
    const response = await post("admin","production",false);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ok:false,code:"admin_authority_unavailable"});
    expect(prepare).not.toHaveBeenCalled();
  });

  it.each([[null,401],["member",403]] as const)("preserves the admin gate for %s",async (role,status) => {
    const response = await post(role,"production");
    expect(response.status).toBe(status);
    expect(prepare).not.toHaveBeenCalled();
    expect(outbound).not.toHaveBeenCalled();
  });

  it("does not let another HTTP method bypass the boundary",async () => {
    const response = await post("admin","production",true,"GET");
    expect(response.status).toBe(405);
    expect(prepare).not.toHaveBeenCalled();
    expect(outbound).not.toHaveBeenCalled();
  });
});
