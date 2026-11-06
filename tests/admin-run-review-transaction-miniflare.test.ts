import { Miniflare } from "miniflare";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureAdminSchema, updateRunReviewStatus } from "../lib/admin-store";
import type { D1Database } from "../lib/d1";

let mf: Miniflare;
let db: D1Database;
const actor = {provider:"google" as const,providerId:"actor",email:"actor@example.test"};
const update = () => updateRunReviewStatus({DB:db},"fixture-run","approved",actor);
const state = async () => ({
  review:await db.prepare("SELECT status FROM run_reviews WHERE id='fixture-run'").first(),
  run:await db.prepare("SELECT status FROM query_runs WHERE id='fixture-run'").first(),
  audit:await db.prepare("SELECT count(*) n FROM audit_events WHERE action='query.approved'").first()
});
const original = {review:{status:"needs_approval"},run:{status:"needs_approval"},audit:{n:0}};

describe("legacy run review transaction on installed local D1",() => {
  beforeAll(async () => {
    mf = new Miniflare({host:"127.0.0.1",port:0,modules:true,
      script:"export default {fetch(){return new Response('Local review transaction test');}}",
      d1Databases:{DB:"local-review-transaction"},d1Persist:false});
    db = await mf.getD1Database("DB") as unknown as D1Database;
    await ensureAdminSchema(db);
    await db.prepare(`INSERT INTO users VALUES ('google:actor','google','actor','actor@example.test',
      'Actor',NULL,'admin','fixture','fixture','fixture')`).run();
    await db.prepare(`INSERT INTO run_reviews VALUES ('fixture-run','fixture-workspace','Synthetic preview',
      'needs_approval',0.1,100,'fixture')`).run();
    await db.prepare(`INSERT INTO query_runs VALUES ('fixture-run','fixture-workspace',NULL,'SELECT 1',
      'needs_approval','simulated',0.1,100,10,'[]','[]',NULL,'fixture','fixture')`).run();
  },30000);
  beforeEach(async () => {
    await db.prepare("DROP TRIGGER IF EXISTS injected_failure").run();
    await db.prepare("DELETE FROM audit_events WHERE action='query.approved'").run();
    await db.prepare("UPDATE query_runs SET status='needs_approval' WHERE id='fixture-run'").run();
    await db.prepare("UPDATE run_reviews SET status='needs_approval' WHERE id='fixture-run'").run();
    await db.prepare("UPDATE users SET role='admin' WHERE id='google:actor'").run();
  });
  afterEach(() => {vi.restoreAllMocks();});
  afterAll(async () => {await mf?.dispose();});

  it("commits both statuses and an audit together",async () => {
    expect(await update()).toMatchObject({ok:true,value:{id:"fixture-run",status:"approved"}});
    expect(await state()).toEqual({review:{status:"approved"},run:{status:"approved"},audit:{n:1}});
  });

  it.each([
    ["audit","BEFORE INSERT ON audit_events"],
    ["query","BEFORE UPDATE OF status ON query_runs"],
    ["review","BEFORE UPDATE OF status ON run_reviews"]
  ])("rolls back all writes when %s aborts",async (_label,clause) => {
    await db.prepare(`CREATE TRIGGER injected_failure ${clause}
      BEGIN SELECT RAISE(ABORT,'synthetic transaction failure'); END`).run();
    await expect(update()).rejects.toThrow();
    expect(await state()).toEqual(original);
  });

  it.each([
    ["audit","BEFORE INSERT ON audit_events",false],
    ["query","BEFORE UPDATE OF status ON query_runs",true],
    ["review","BEFORE UPDATE OF status ON run_reviews",true]
  ])("keeps no partial review when %s is skipped",async (_label,clause,aborts) => {
    await db.prepare(`CREATE TRIGGER injected_failure ${clause} BEGIN SELECT RAISE(IGNORE); END`).run();
    if (aborts) await expect(update()).rejects.toThrow();
    else expect(await update()).toMatchObject({ok:false,status:403});
    expect(await state()).toEqual(original);
  });

  it.each([false,true])("preserves history when a colliding audit is skipped, revoked=%s",async revoked => {
    await db.prepare("INSERT INTO audit_events VALUES ('collision','prior@example.test','query.approved','prior','{}','prior')").run();
    await db.prepare("CREATE TRIGGER injected_failure BEFORE INSERT ON audit_events BEGIN SELECT RAISE(IGNORE); END").run();
    if (revoked) await db.prepare("UPDATE users SET role='member' WHERE id='google:actor'").run();
    vi.spyOn(crypto,"randomUUID").mockReturnValue("collision");
    await expect(update()).rejects.toThrow();
    expect(await state()).toEqual({...original,audit:{n:1}});
    expect(await db.prepare("SELECT * FROM audit_events WHERE id='collision'").first()).toEqual({
      id:"collision",actor_email:"prior@example.test",action:"query.approved",target:"prior",
      metadata_json:"{}",created_at:"prior"
    });
  });
});
