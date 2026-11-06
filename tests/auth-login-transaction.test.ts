import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureAdminSchema, upsertAuthenticatedUser } from "../lib/admin-store";
import type { AuthSession } from "../lib/auth";
import { jobSqlite, jobTransactionalDatabase } from "./fixtures/job-sqlite";

let dir: string, file: string, baseline: string;
const base = jobTransactionalDatabase(() => file);
const db = {...base,batch:base.batch!};
const incoming: AuthSession = {provider:"google",providerId:"known",email:"renamed@example.test",
  name:"Renamed",avatarUrl:"https://avatar.example.test/local",role:"admin",expiresAt:4102444800000};
const sql = (query: string) => jobSqlite(file,"run",query);
const login = (session = incoming) => upsertAuthenticatedUser({DB:db},session);

describe("atomic login profile and required audit",() => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(),"odap-login-transaction-"));
    file = baseline = join(dir,"baseline.sqlite");
    await ensureAdminSchema(db);
    await sql(`INSERT INTO users VALUES ('google:known','google','known','known@example.test',
      'Known',NULL,'member','fixture','fixture','fixture')`);
  },20000);
  beforeEach(async () => {
    file = join(dir,"case.sqlite");
    await copyFile(baseline,file);
    vi.stubGlobal("fetch",vi.fn(async () => {throw new Error("Unexpected network call");}));
  });
  afterEach(() => {vi.unstubAllGlobals();vi.restoreAllMocks();});
  afterAll(async () => {if (dir) await rm(dir,{recursive:true,force:true});});

  it("updates a verified profile without restoring its incoming admin role",async () => {
    expect(await login()).toEqual({persisted:true,storageBinding:"DB",role:"member"});
    const row = await jobSqlite(file,"readonly-first","SELECT * FROM users");
    expect(row).toMatchObject({id:"google:known",provider:"google",provider_id:"known",
      email:incoming.email,name:incoming.name,avatar_url:incoming.avatarUrl,role:"member",created_at:"fixture"});
    expect(row.last_login_at).toBe(row.updated_at);
    expect(await jobSqlite(file,"readonly-first","SELECT actor_email,action,target,metadata_json,created_at FROM audit_events"))
      .toEqual({actor_email:incoming.email,action:"auth.login",target:"google",
        metadata_json:JSON.stringify({role:"member",providerId:"known"}),created_at:row.last_login_at});
    expect(fetch).not.toHaveBeenCalled();
  },20000);

  it.each(["admin","member"] as const)("records a new subject's initial %s role",async role => {
    expect(await login({...incoming,provider:"github",providerId:"new",role,avatarUrl:undefined}))
      .toEqual({persisted:true,storageBinding:"DB",role});
    expect(await jobSqlite(file,"readonly-first","SELECT id,role,avatar_url FROM users WHERE id='github:new'"))
      .toEqual({id:"github:new",role,avatar_url:null});
    expect(await jobSqlite(file,"readonly-first","SELECT target,json_extract(metadata_json,'$.role') role FROM audit_events"))
      .toEqual({target:"github",role});
  },20000);

  it.each([
    ["user insert","BEFORE INSERT ON users","ABORT"],
    ["user update","BEFORE UPDATE ON users","ABORT"],
    ["audit insert","BEFORE INSERT ON audit_events","ABORT"],
    ["user insert","BEFORE INSERT ON users","IGNORE"],
    ["user update","BEFORE UPDATE ON users","IGNORE"],
    ["audit insert","BEFORE INSERT ON audit_events","IGNORE"]
  ])("rolls back %s (%s) on %s",async (_label,clause,mode) => {
    await sql(`CREATE TRIGGER failed_login_write ${clause}
      BEGIN SELECT RAISE(${mode}${mode === "ABORT" ? ",'synthetic failure'" : ""}); END`);
    const before = await readFile(file);
    await expect(login()).rejects.toThrow();
    expect(await readFile(file)).toEqual(before);
  },20000);

  it.each(["ABORT","IGNORE"])("does not retain a new user when its audit uses %s",async mode => {
    await sql(`CREATE TRIGGER failed_login_audit BEFORE INSERT ON audit_events
      BEGIN SELECT RAISE(${mode}${mode === "ABORT" ? ",'synthetic failure'" : ""}); END`);
    const before = await readFile(file);
    await expect(login({...incoming,providerId:"new"})).rejects.toThrow();
    expect(await readFile(file)).toEqual(before);
  },20000);

  it.each([[false,false],[false,true],[true,false],[true,true]])(
    "preserves historical audit collision, new=%s ignored=%s",async (isNew,ignored) => {
      await sql("INSERT INTO audit_events VALUES ('collision','prior@example.test','auth.login','github','{}','prior')");
      if (ignored) await sql("CREATE TRIGGER ignored_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(IGNORE); END");
      vi.spyOn(crypto,"randomUUID").mockReturnValue("collision");
      const before = await readFile(file);
      await expect(login({...incoming,providerId:isNew ? "new" : "known"})).rejects.toThrow();
      expect(await readFile(file)).toEqual(before);
    },20000);

  it("rejects an invalid stored role without changing profile data",async () => {
    await sql("UPDATE users SET role='invalid' WHERE id='google:known'");
    const before = await readFile(file);
    await expect(login()).rejects.toThrow();
    expect(await readFile(file)).toEqual(before);
  },20000);

  it("requires an atomic binding before schema writes and does not fall back",async () => {
    const prepare = vi.fn(), before = await readFile(file);
    await expect(upsertAuthenticatedUser({ODAP_GATEWAY_DB:{prepare},DB:db},incoming))
      .rejects.toThrow("Transactional storage");
    expect(prepare).not.toHaveBeenCalled();
    expect(await readFile(file)).toEqual(before);
  });

  it("reports unconfigured storage without attempting persistence",async () => {
    expect(await upsertAuthenticatedUser({},incoming)).toEqual({persisted:false,storageBinding:null,role:null});
  });

  it("allows only one new identity to acquire a shared email under contention",async () => {
    let release!: () => void;
    const ready = new Promise<void>(resolve => {release=resolve;});
    const batch = db.batch.bind(db);
    let arrivals = 0;
    vi.spyOn(db,"batch").mockImplementation(async statements => {
      if (++arrivals === 2) release();
      await ready;
      return batch(statements);
    });
    const results = await Promise.allSettled([
      login({...incoming,providerId:"new"}),login({...incoming,provider:"github",providerId:"other"})
    ]);
    expect(results.map(result => result.status).sort()).toEqual(["fulfilled","rejected"]);
    expect(await jobSqlite(file,"readonly-first","SELECT count(*) n FROM users WHERE email='renamed@example.test'"))
      .toEqual({n:1});
    expect(await jobSqlite(file,"readonly-first","SELECT count(*) n FROM audit_events")).toEqual({n:1});
    expect(await jobSqlite(file,"readonly-first",`SELECT count(*) n FROM audit_events a JOIN users u
      ON u.provider=a.target AND u.provider_id=json_extract(a.metadata_json,'$.providerId')
      AND u.role=json_extract(a.metadata_json,'$.role') AND u.email=a.actor_email WHERE a.action='auth.login'`))
      .toEqual({n:1});
  },30000);
});
