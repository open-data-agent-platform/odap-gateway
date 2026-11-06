import { Miniflare } from "miniflare";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureAdminSchema, updateFeatureRollout } from "../lib/admin-store";
import type { D1Database } from "../lib/d1";

let mf: Miniflare;
let db: D1Database;
const actor = {provider:"google" as const,providerId:"actor",email:"actor@example.test"};
const update = () => updateFeatureRollout({DB:db},"fixture-flag",100,actor);
const state = async () => ({
  flag: await db.prepare("SELECT rollout,status FROM feature_flags WHERE id='fixture-flag'").first(),
  audit: await db.prepare("SELECT count(*) n FROM audit_events WHERE action='feature_flag.rollout_updated'").first()
});

describe("feature rollout transaction on installed local D1",() => {
  beforeAll(async () => {
    mf = new Miniflare({host:"127.0.0.1",port:0,modules:true,
      script:"export default {fetch(){return new Response('Local feature transaction test');}}",
      d1Databases:{DB:"local-feature-transaction"},d1Persist:false});
    db = await mf.getD1Database("DB") as unknown as D1Database;
    await ensureAdminSchema(db);
    await db.prepare(`INSERT INTO users VALUES ('google:actor','google','actor','actor@example.test',
      'Actor',NULL,'admin','fixture','fixture','fixture')`).run();
    await db.prepare(`INSERT INTO feature_flags VALUES ('fixture-flag','Synthetic flag','Local only',
      'paused','staging',0,'fixture-owner','fixture')`).run();
  },30000);
  beforeEach(async () => {
    await db.prepare("DROP TRIGGER IF EXISTS injected_failure").run();
    await db.prepare("DELETE FROM audit_events WHERE action='feature_flag.rollout_updated'").run();
    await db.prepare("UPDATE feature_flags SET rollout=0,status='paused' WHERE id='fixture-flag'").run();
    await db.prepare("UPDATE users SET role='admin' WHERE id='google:actor'").run();
  });
  afterEach(() => {vi.restoreAllMocks();});
  afterAll(async () => {await mf?.dispose();});

  it("commits the returned flag and one audit together",async () => {
    expect(await update()).toMatchObject({ok:true,value:{id:"fixture-flag",rollout:100,status:"enabled"}});
    expect(await state()).toEqual({flag:{rollout:100,status:"enabled"},audit:{n:1}});
  });

  it.each([
    ["audit","BEFORE INSERT ON audit_events WHEN NEW.action='feature_flag.rollout_updated'"],
    ["flag","BEFORE UPDATE OF rollout,status ON feature_flags"]
  ])("rolls back both writes when %s aborts",async (_label,clause) => {
    await db.prepare(`CREATE TRIGGER injected_failure ${clause}
      BEGIN SELECT RAISE(ABORT,'synthetic transaction failure'); END`).run();
    await expect(update()).rejects.toThrow();
    expect(await state()).toEqual({flag:{rollout:0,status:"paused"},audit:{n:0}});
  });

  it.each([
    ["audit","BEFORE INSERT ON audit_events WHEN NEW.action='feature_flag.rollout_updated'",false],
    ["flag","BEFORE UPDATE OF rollout,status ON feature_flags",true]
  ])("keeps neither change when %s is skipped",async (_label,clause,aborts) => {
    await db.prepare(`CREATE TRIGGER injected_failure ${clause}
      BEGIN SELECT RAISE(IGNORE); END`).run();
    if (aborts) await expect(update()).rejects.toThrow();
    else expect(await update()).toMatchObject({ok:false,status:403});
    expect(await state()).toEqual({flag:{rollout:0,status:"paused"},audit:{n:0}});
  });

  it.each([false,true])("preserves history if a colliding audit insert is skipped, revoked=%s",async revoked => {
    await db.prepare(`INSERT INTO audit_events VALUES ('collision','prior@example.test',
      'feature_flag.rollout_updated','prior-target','{}','prior-time')`).run();
    await db.prepare(`CREATE TRIGGER injected_failure BEFORE INSERT ON audit_events
      BEGIN SELECT RAISE(IGNORE); END`).run();
    if (revoked) await db.prepare("UPDATE users SET role='member' WHERE id='google:actor'").run();
    vi.spyOn(crypto,"randomUUID").mockReturnValue("collision");
    let failed = false;
    try {await update();} catch {failed = true;}
    expect({failed,...await state()}).toEqual({failed:true,flag:{rollout:0,status:"paused"},audit:{n:1}});
    expect(await db.prepare("SELECT * FROM audit_events WHERE id='collision'").first()).toEqual({
      id:"collision",actor_email:"prior@example.test",action:"feature_flag.rollout_updated",
      target:"prior-target",metadata_json:"{}",created_at:"prior-time"
    });
  });
});
