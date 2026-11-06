import { Miniflare } from "miniflare";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureAdminSchema, upsertAuthenticatedUser } from "../lib/admin-store";
import type { AuthSession } from "../lib/auth";
import type { D1Database } from "../lib/d1";

let mf: Miniflare, db: D1Database;
const incoming: AuthSession = {provider:"google",providerId:"known",email:"renamed@example.test",
  name:"Renamed",role:"admin",expiresAt:4102444800000};
const login = (isNew = false) => upsertAuthenticatedUser({DB:db},{...incoming,providerId:isNew ? "new" : "known"});
const state = async () => ({
  users:(await db.prepare("SELECT * FROM users ORDER BY id").all()).results,
  audit:(await db.prepare("SELECT * FROM audit_events ORDER BY id").all()).results
});

describe("login transaction on installed local D1",() => {
  beforeAll(async () => {
    mf = new Miniflare({host:"127.0.0.1",port:0,modules:true,
      script:"export default {fetch(){return new Response('Local login transaction test');}}",
      d1Databases:{DB:"local-login-transaction"},d1Persist:false});
    db = await mf.getD1Database("DB") as unknown as D1Database;
    await ensureAdminSchema(db);
  },30000);
  beforeEach(async () => {
    await db.prepare("DROP TRIGGER IF EXISTS injected_failure").run();
    await db.prepare("DELETE FROM audit_events").run();
    await db.prepare("DELETE FROM users").run();
    await db.prepare(`INSERT INTO users VALUES ('google:known','google','known','known@example.test',
      'Known',NULL,'member','fixture','fixture','fixture')`).run();
  });
  afterEach(() => {vi.restoreAllMocks();});
  afterAll(async () => {await mf?.dispose();});

  it.each([false,true])("commits the actual role with its audit, new=%s",async isNew => {
    const role = isNew ? "admin" : "member", providerId = isNew ? "new" : "known";
    expect(await login(isNew)).toEqual({persisted:true,storageBinding:"DB",role});
    expect(await db.prepare("SELECT role,email FROM users WHERE id=?").bind(`google:${providerId}`).first())
      .toEqual({role,email:incoming.email});
    expect(await db.prepare("SELECT actor_email,target,metadata_json FROM audit_events").first())
      .toEqual({actor_email:incoming.email,target:"google",metadata_json:JSON.stringify({role,providerId})});
  });

  it.each([
    ["user insert","BEFORE INSERT ON users","ABORT"],
    ["user update","BEFORE UPDATE ON users","ABORT"],
    ["audit","BEFORE INSERT ON audit_events","ABORT"],
    ["user insert","BEFORE INSERT ON users","IGNORE"],
    ["user update","BEFORE UPDATE ON users","IGNORE"],
    ["audit","BEFORE INSERT ON audit_events","IGNORE"]
  ])("rolls back %s (%s) on %s",async (_label,clause,mode) => {
    await db.prepare(`CREATE TRIGGER injected_failure ${clause}
      BEGIN SELECT RAISE(${mode}${mode === "ABORT" ? ",'synthetic failure'" : ""}); END`).run();
    const before = await state();
    await expect(login()).rejects.toThrow();
    expect(await state()).toEqual(before);
  });

  it.each([false,true])("preserves historical audit when colliding insert is skipped, new=%s",async isNew => {
    await db.prepare("INSERT INTO audit_events VALUES ('collision','prior@example.test','auth.login','github','{}','prior')").run();
    await db.prepare("CREATE TRIGGER injected_failure BEFORE INSERT ON audit_events BEGIN SELECT RAISE(IGNORE); END").run();
    vi.spyOn(crypto,"randomUUID").mockReturnValue("collision");
    const before = await state();
    await expect(login(isNew)).rejects.toThrow();
    expect(await state()).toEqual(before);
  });
});
