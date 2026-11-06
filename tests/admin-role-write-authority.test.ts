import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionCookie, signAuthPayload } from "../lib/auth";
import { ensureAdminSchema, updateAdminUserRole } from "../lib/admin-store";
import { jobTransactionalDatabase, jobSqlite } from "./fixtures/job-sqlite";
import worker from "../worker";
import { withBodyReadHook } from "./fixtures/request-body-hook";

let dir: string, file: string, baseline: string, cookie: string;
let beforeRoleWrite: (() => Promise<void>) | null = null;
const base = jobTransactionalDatabase(() => file);
const db = {...base,batch: async (statements: Parameters<NonNullable<typeof base.batch>>[0]) => {
  const fn = beforeRoleWrite;
  beforeRoleWrite = null;
  await fn?.();
  return base.batch!(statements);
}};
const env = {AUTH_COOKIE_SECRET:"synthetic-role-write",DB:db,
  ADMIN_EMAILS:"actor@example.test",ASSETS:{fetch:async () => {throw new Error("Unexpected asset");}}};
const sql = (query: string) => jobSqlite(file,"run",query);
const storedRole = (id = "google:target") => jobSqlite(file,"readonly-first","SELECT role FROM users WHERE id=?",[id]);
const auditCount = () => jobSqlite(file,"readonly-first","SELECT count(*) n FROM audit_events WHERE action='user.role_updated'");
const request = (id = "google:target",role = "admin") => new Request("https://gateway.test/api/admin/users/"+encodeURIComponent(id),{
  method:"PATCH",headers:{Cookie:cookie,"Content-Type":"application/json"},body:JSON.stringify({role})
});
const submit = (input = request()) => worker.fetch(input,env,{waitUntil:() => {throw new Error("Unexpected background task");}});

describe("current authority at the role write",() => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(),"odap-role-write-"));
    file = baseline = join(dir,"baseline.sqlite");
    await ensureAdminSchema(db);
    for (const id of ["actor","target"])
      await jobSqlite(file,"run",`INSERT INTO users(id,provider,provider_id,email,name,role,last_login_at,created_at,updated_at)
        VALUES (?,'google',?,?,?,?,'fixture','fixture','fixture')`,
        ["google:"+id,id,id+"@example.test",id,id === "actor" ? "admin" : "member"]);
    cookie = createSessionCookie(await signAuthPayload({provider:"google",providerId:"actor",email:"actor@example.test",
      name:"Actor",role:"admin",expiresAt:Date.now()+600000},env.AUTH_COOKIE_SECRET));
  },20000);
  beforeEach(async () => {
    file = join(dir,"case.sqlite"); await copyFile(baseline,file);
    beforeRoleWrite = null;
    vi.stubGlobal("fetch",vi.fn(async () => {throw new Error("Unexpected network call");}));
    vi.spyOn(console,"error").mockImplementation(() => {});
  });
  afterEach(() => {vi.unstubAllGlobals();vi.restoreAllMocks();});
  afterAll(async () => {if (dir) await rm(dir,{recursive:true,force:true});});

  it("rejects a grant when the actor is demoted immediately before the SQL write",async () => {
    let afterRevocation: Buffer | undefined;
    beforeRoleWrite = async () => {
      await sql("UPDATE users SET role='member' WHERE id='google:actor'");
      afterRevocation = await readFile(file);
    };
    const response = await submit();
    expect(beforeRoleWrite).toBeNull();
    expect({status:response.status,target:await storedRole()}).toEqual({status:403,target:{role:"member"}});
    expect(await auditCount()).toEqual({n:0});
    expect(await readFile(file)).toEqual(afterRevocation);
    expect(fetch).not.toHaveBeenCalled();
  },20000);

  it.each([
    ["removed actor","DELETE FROM users WHERE id='google:actor'"],
    ["rebound subject","UPDATE users SET provider_id='replacement' WHERE id='google:actor'"],
    ["rebound provider","UPDATE users SET provider='github' WHERE id='google:actor'"],
    ["changed audit contact","UPDATE users SET email='renamed@example.test' WHERE id='google:actor'"],
    ["changed target contact","UPDATE users SET email='renamed@example.test' WHERE id='google:target'"]
  ])("refuses %s at the final write without a success audit",async (_label,change) => {
    let afterChange: Buffer | undefined;
    beforeRoleWrite = async () => {await sql(change); afterChange = await readFile(file);};
    const response = await submit();
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({code:"admin_user_update_denied"});
    expect(await storedRole()).toEqual({role:"member"});
    expect(await auditCount()).toEqual({n:0});
    expect(await readFile(file)).toEqual(afterChange);
    expect(beforeRoleWrite).toBeNull();
  },20000);

  it("rechecks a demotion committed while the request body is being read",async () => {
    const revoke = vi.fn(() => sql("UPDATE users SET role='member' WHERE id='google:actor'"));
    expect((await submit(withBodyReadHook(request(), revoke))).status).toBe(403);
    expect(revoke).toHaveBeenCalledOnce();
    expect(await storedRole()).toEqual({role:"member"});
    expect(await auditCount()).toEqual({n:0});
  },20000);

  it("does not overwrite an intervening target-role change",async () => {
    let afterChange: Buffer | undefined;
    beforeRoleWrite = async () => {
      await sql("UPDATE users SET role='admin' WHERE id='google:target'");
      afterChange = await readFile(file);
    };
    const response = await submit(request("google:target","member"));
    expect(response.status).toBe(403);
    expect(await storedRole()).toEqual({role:"admin"});
    expect(await auditCount()).toEqual({n:0});
    expect(await readFile(file)).toEqual(afterChange);
  },20000);

  it("does not invent a successful update after the target was removed",async () => {
    beforeRoleWrite = async () => {await sql("DELETE FROM users WHERE id='google:target'");};
    expect((await submit()).status).toBe(403);
    expect(await storedRole()).toBeNull();
    expect(await auditCount()).toEqual({n:0});
  },20000);

  it("binds self-demotion protection to subject rather than an outdated email",async () => {
    const rename = vi.fn(() => sql("UPDATE users SET email='renamed@example.test' WHERE id='google:actor'"));
    const response = await submit(withBodyReadHook(request("google:actor","member"), rename));
    expect(rename).toHaveBeenCalledOnce();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({code:"cannot_demote_self"});
    expect(await storedRole("google:actor")).toEqual({role:"admin"});
    expect(await auditCount()).toEqual({n:0});
  },20000);

  it("returns the actual row and audit metadata for a current administrator",async () => {
    const response = await submit();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ok:true,user:{id:"google:target",role:"admin",createdAt:"fixture"}});
    expect(await storedRole()).toEqual({role:"admin"});
    expect(await jobSqlite(file,"readonly-first",`SELECT actor_email,target,
      json_extract(metadata_json,'$.previousRole') previous_role,
      json_extract(metadata_json,'$.role') role FROM audit_events WHERE action='user.role_updated'`))
      .toEqual({actor_email:"actor@example.test",target:"target@example.test",previous_role:"member",role:"admin"});
    expect(fetch).not.toHaveBeenCalled();
  },20000);

  it("rolls back a role change when its required audit insert fails",async () => {
    await sql(`CREATE TRIGGER fail_role_audit BEFORE INSERT ON audit_events
      WHEN NEW.action='user.role_updated' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END`);
    const before = await readFile(file);
    const response = await submit();
    expect(response.status).toBe(500);
    expect(await storedRole()).toEqual({role:"member"});
    expect(await auditCount()).toEqual({n:0});
    expect(await readFile(file)).toEqual(before);
  },20000);

  it.each([
    ["audit insert", "BEFORE INSERT ON audit_events WHEN NEW.action='user.role_updated'",403],
    ["role update", "BEFORE UPDATE OF role ON users",500]
  ])("leaves neither change nor success audit when the %s is ignored",async (_label,clause,status) => {
    await sql(`CREATE TRIGGER ignore_role_change ${clause} BEGIN SELECT RAISE(IGNORE); END`);
    const response = await submit();
    expect(response.status).toBe(status);
    expect(await storedRole()).toEqual({role:"member"});
    expect(await auditCount()).toEqual({n:0});
  },20000);

  it("rolls back the tentative audit when the subsequent role update fails",async () => {
    await sql(`CREATE TRIGGER fail_role_update BEFORE UPDATE OF role ON users
      BEGIN SELECT RAISE(ABORT,'synthetic role failure'); END`);
    const before = await readFile(file);
    expect((await submit()).status).toBe(500);
    expect(await storedRole()).toEqual({role:"member"});
    expect(await auditCount()).toEqual({n:0});
    expect(await readFile(file)).toEqual(before);
  },20000);

  it("preserves an existing audit record on a generated ID collision",async () => {
    await sql(`INSERT INTO audit_events VALUES ('collision','prior@example.test','user.role_updated',
      'prior-target','{}','prior-time')`);
    const before = await readFile(file);
    vi.spyOn(crypto,"randomUUID").mockReturnValue("collision");
    expect((await submit()).status).toBe(500);
    expect(await storedRole()).toEqual({role:"member"});
    expect(await auditCount()).toEqual({n:1});
    expect(await readFile(file)).toEqual(before);
  },20000);

  it("does not retry after a lost acknowledgment of a committed transaction",async () => {
    const batch = vi.spyOn(db,"batch").mockImplementation(async statements => {
      await base.batch!(statements);
      throw new Error("Synthetic acknowledgment loss");
    });
    expect((await submit()).status).toBe(500);
    expect(await storedRole()).toEqual({role:"admin"});
    expect(await auditCount()).toEqual({n:1});
    expect(batch).toHaveBeenCalledTimes(1);
  },20000);

  it("preserves history on an ID collision even when current authority is denied",async () => {
    await sql(`INSERT INTO audit_events VALUES ('collision','prior@example.test','user.role_updated',
      'prior-target','{}','prior-time')`);
    let before: Buffer | undefined;
    beforeRoleWrite = async () => {
      await sql("DELETE FROM users WHERE id='google:actor'");
      before = await readFile(file);
    };
    vi.spyOn(crypto,"randomUUID").mockReturnValue("collision");
    expect((await submit()).status).toBe(500);
    expect(await storedRole()).toEqual({role:"member"});
    expect(await auditCount()).toEqual({n:1});
    expect(await readFile(file)).toEqual(before);
  },20000);

  it("refuses a missing transaction API before schema writes without binding fallback",async () => {
    const prepare = vi.fn();
    const before = await readFile(file);
    expect(await updateAdminUserRole({ODAP_GATEWAY_DB:{prepare},DB:db},"google:target","admin",
      {provider:"google",providerId:"actor",email:"actor@example.test"}))
      .toMatchObject({ok:false,status:503,code:"admin_role_transaction_unavailable"});
    expect(prepare).not.toHaveBeenCalled();
    expect(await readFile(file)).toEqual(before);
  });

  it("does not report success for an unsuccessful batch acknowledgment",async () => {
    const batch = vi.spyOn(db,"batch").mockResolvedValue([
      {success:true,results:[]},{success:false,results:[]},{success:true,results:[]}
    ]);
    const before = await readFile(file);
    expect((await submit()).status).toBe(500);
    expect(await readFile(file)).toEqual(before);
    expect(batch).toHaveBeenCalledTimes(1);
  },20000);

  it("commits one role/audit pair when two requests share the previous-role snapshot",async () => {
    let release!: () => void;
    const ready = new Promise<void>(resolve => {release = resolve;});
    let arrivals = 0;
    vi.spyOn(db,"batch").mockImplementation(async statements => {
      if (++arrivals === 2) release();
      await ready;
      return base.batch!(statements);
    });
    const responses = await Promise.all([submit(),submit()]);
    expect(responses.map(response => response.status).sort()).toEqual([200,403]);
    expect(await storedRole()).toEqual({role:"admin"});
    expect(await auditCount()).toEqual({n:1});
  },20000);
});
