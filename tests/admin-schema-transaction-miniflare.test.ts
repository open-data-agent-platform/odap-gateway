import { Miniflare } from "miniflare";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureAdminSchema, updateSchemaFieldPolicy } from "../lib/admin-store";
import type { D1Database } from "../lib/d1";

let mf: Miniflare;
let db: D1Database;
const actor = {provider:"google" as const,providerId:"actor",email:"actor@example.test"};
const update = () => updateSchemaFieldPolicy({DB:db},"contact",{queryable:true,pii:false},actor);
const state = async () => ({
  policy: await db.prepare("SELECT queryable,pii FROM schema_fields WHERE id='contact'").first(),
  audit: await db.prepare("SELECT count(*) n FROM audit_events WHERE action='schema_field.policy_updated'").first()
});

describe("schema policy transaction on installed local D1",() => {
  beforeAll(async () => {
    mf = new Miniflare({host:"127.0.0.1",port:0,modules:true,
      script:"export default {fetch(){return new Response('Local schema transaction test');}}",
      d1Databases:{DB:"local-schema-transaction"},d1Persist:false});
    db = await mf.getD1Database("DB") as unknown as D1Database;
    await ensureAdminSchema(db);
    await db.prepare(`INSERT INTO users VALUES ('google:actor','google','actor','actor@example.test',
      'Actor',NULL,'admin','fixture','fixture','fixture')`).run();
    await db.prepare(`INSERT INTO schema_tables VALUES ('t','workspace','orders','Synthetic',0,'fixture')`).run();
    await db.prepare(`INSERT INTO schema_fields VALUES ('contact','t','contact','STRING','NULLABLE',
      'Synthetic contact',1,0,0,'fixture')`).run();
  },30000);
  beforeEach(async () => {
    await db.prepare("DROP TRIGGER IF EXISTS injected_failure").run();
    await db.prepare("DELETE FROM audit_events WHERE action='schema_field.policy_updated'").run();
    await db.prepare("UPDATE schema_fields SET queryable=0,pii=1 WHERE id='contact'").run();
    await db.prepare("UPDATE users SET role='admin' WHERE id='google:actor'").run();
  });
  afterEach(() => {vi.restoreAllMocks();});
  afterAll(async () => {await mf?.dispose();});

  it("commits the returned policy and one audit together",async () => {
    expect(await update()).toMatchObject({ok:true,value:{id:"contact",queryable:true,pii:false}});
    expect(await state()).toEqual({policy:{queryable:1,pii:0},audit:{n:1}});
  });

  it.each([
    ["audit","BEFORE INSERT ON audit_events WHEN NEW.action='schema_field.policy_updated'"],
    ["policy","BEFORE UPDATE OF queryable,pii ON schema_fields"]
  ])("rolls back both writes when %s aborts",async (_label,clause) => {
    await db.prepare(`CREATE TRIGGER injected_failure ${clause}
      BEGIN SELECT RAISE(ABORT,'synthetic transaction failure'); END`).run();
    await expect(update()).rejects.toThrow();
    expect(await state()).toEqual({policy:{queryable:0,pii:1},audit:{n:0}});
  });

  it.each([
    ["audit","BEFORE INSERT ON audit_events WHEN NEW.action='schema_field.policy_updated'",false],
    ["policy","BEFORE UPDATE OF queryable,pii ON schema_fields",true]
  ])("keeps neither change when %s is skipped",async (_label,clause,aborts) => {
    await db.prepare(`CREATE TRIGGER injected_failure ${clause}
      BEGIN SELECT RAISE(IGNORE); END`).run();
    if (aborts) await expect(update()).rejects.toThrow();
    else expect(await update()).toMatchObject({ok:false,status:403});
    expect(await state()).toEqual({policy:{queryable:0,pii:1},audit:{n:0}});
  });

  it.each([false,true])("preserves history if a colliding audit insert is skipped, revoked=%s",async revoked => {
    await db.prepare(`INSERT INTO audit_events VALUES ('collision','prior@example.test',
      'schema_field.policy_updated','prior-target','{}','prior-time')`).run();
    await db.prepare(`CREATE TRIGGER injected_failure BEFORE INSERT ON audit_events
      BEGIN SELECT RAISE(IGNORE); END`).run();
    if (revoked) await db.prepare("UPDATE users SET role='member' WHERE id='google:actor'").run();
    vi.spyOn(crypto,"randomUUID").mockReturnValue("collision");
    let failed = false;
    try {await update();} catch {failed = true;}
    expect({failed,...await state()}).toEqual({failed:true,policy:{queryable:0,pii:1},audit:{n:1}});
    expect(await db.prepare("SELECT * FROM audit_events WHERE id='collision'").first()).toEqual({
      id:"collision",actor_email:"prior@example.test",action:"schema_field.policy_updated",
      target:"prior-target",metadata_json:"{}",created_at:"prior-time"
    });
  });
});
