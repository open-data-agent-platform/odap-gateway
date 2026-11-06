import { Miniflare } from "miniflare";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureAdminSchema, updateAdminUserRole } from "../lib/admin-store";
import type { D1Database } from "../lib/d1";

let mf: Miniflare;
let db: D1Database;
const actor = {provider:"google" as const,providerId:"actor",email:"actor@example.test"};
const update = () => updateAdminUserRole({DB:db},"google:target","admin",actor);
const state = async () => ({
  user: await db.prepare("SELECT role FROM users WHERE id='google:target'").first(),
  audit: await db.prepare("SELECT count(*) n FROM audit_events WHERE action='user.role_updated'").first()
});

describe("role transaction on the installed local D1 runtime",() => {
  beforeAll(async () => {
    mf = new Miniflare({
      host:"127.0.0.1",port:0,modules:true,
      script:"export default {fetch(){return new Response('Local transaction test');}}",
      d1Databases:{DB:"local-role-transaction"},d1Persist:false
    });
    db = await mf.getD1Database("DB") as unknown as D1Database;
    await ensureAdminSchema(db);
    for (const id of ["actor","target"]) {
      await db.prepare(`INSERT INTO users (id,provider,provider_id,email,name,role,last_login_at,created_at,updated_at)
        VALUES (?,'google',?,?,?,?,'fixture','fixture','fixture')`)
        .bind("google:"+id,id,id+"@example.test",id,id === "actor" ? "admin" : "member").run();
    }
  },30000);
  beforeEach(async () => {
    await db.prepare("DROP TRIGGER IF EXISTS injected_failure").run();
    await db.prepare("DELETE FROM audit_events WHERE action='user.role_updated'").run();
    await db.prepare("UPDATE users SET role='member' WHERE id='google:target'").run();
    await db.prepare("UPDATE users SET role='admin' WHERE id='google:actor'").run();
  });
  afterEach(() => {vi.restoreAllMocks();});
  afterAll(async () => {await mf?.dispose();});

  it("retains one audit and the returned role snapshot on success",async () => {
    expect(await update()).toMatchObject({ok:true,value:{id:"google:target",role:"admin"}});
    expect(await state()).toEqual({user:{role:"admin"},audit:{n:1}});
  });

  it.each([
    ["audit","BEFORE INSERT ON audit_events WHEN NEW.action='user.role_updated'"],
    ["role","BEFORE UPDATE OF role ON users"]
  ])("rolls back when the %s statement aborts",async (_label,clause) => {
    await db.prepare(`CREATE TRIGGER injected_failure ${clause}
      BEGIN SELECT RAISE(ABORT,'synthetic transaction failure'); END`).run();
    await expect(update()).rejects.toThrow();
    expect(await state()).toEqual({user:{role:"member"},audit:{n:0}});
  });

  it.each([
    ["audit","BEFORE INSERT ON audit_events WHEN NEW.action='user.role_updated'",false],
    ["role","BEFORE UPDATE OF role ON users",true]
  ])("keeps neither side when the %s statement is skipped",async (_label,clause,aborts) => {
    await db.prepare(`CREATE TRIGGER injected_failure ${clause}
      BEGIN SELECT RAISE(IGNORE); END`).run();
    if (aborts) await expect(update()).rejects.toThrow();
    else expect(await update()).toMatchObject({ok:false,status:403});
    expect(await state()).toEqual({user:{role:"member"},audit:{n:0}});
  });

  it.each([false,true])("preserves history if a colliding audit insert is skipped, revoked=%s",async revoked => {
    await db.prepare(`INSERT INTO audit_events VALUES ('collision','prior@example.test',
      'user.role_updated','prior-target','{}','prior-time')`).run();
    await db.prepare(`CREATE TRIGGER injected_failure BEFORE INSERT ON audit_events
      BEGIN SELECT RAISE(IGNORE); END`).run();
    if (revoked) await db.prepare("UPDATE users SET role='member' WHERE id='google:actor'").run();
    vi.spyOn(crypto,"randomUUID").mockReturnValue("collision");
    let failed = false;
    try {await update();} catch {failed = true;}
    expect({failed,...await state()}).toEqual({failed:true,user:{role:"member"},audit:{n:1}});
    expect(await db.prepare("SELECT * FROM audit_events WHERE id='collision'").first()).toEqual({
      id:"collision",actor_email:"prior@example.test",action:"user.role_updated",
      target:"prior-target",metadata_json:"{}",created_at:"prior-time"
    });
  });
});
