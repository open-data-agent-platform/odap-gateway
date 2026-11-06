import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { D1Database } from "../lib/d1";
import { ensureAdminSchema, getAdminState, getSchemaPolicyCatalog } from "../lib/admin-store";
import { evaluateSchemaPolicy } from "../lib/schema-policy";

let mf: Miniflare, db: D1Database;
const lists = ["users","feature_flags","workspaces","run_reviews","schema_tables","schema_fields","audit_events"];
const tables = [...lists,"query_runs"];
const snapshot = async () => (await db.batch!(tables.map(table => db.prepare(`SELECT * FROM ${table}`))))
  .map(result => result.results);

function unconfirmedRead(target: string): D1Database {
  return {prepare:query => {
    const statement = db.prepare(query);
    return {
      bind:(...values) => statement.bind(...values),
      first:<T>(column?: string) => statement.first<T>(column),
      run:<T>() => statement.run<T>(),
      all:async <T>() => {
        const result = await statement.all<T>();
        return query.includes(`FROM ${target}`) ? {...result,success:false} : result;
      }
    };
  }};
}

describe("administrator read boundaries on installed local D1",() => {
  beforeAll(async () => {
    mf = new Miniflare({host:"127.0.0.1",port:0,modules:true,
      script:"export default {fetch(){return new Response('Local admin read test');}}",
      d1Databases:{DB:"local-admin-read-boundary"},d1Persist:false});
    db = await mf.getD1Database("DB") as unknown as D1Database;
  },30000);
  beforeEach(async () => {
    for (const table of tables) await db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
    await ensureAdminSchema(db);
    await db.batch!([
      db.prepare("INSERT INTO users VALUES ('google:actor','google','actor','actor@example.test','Actor',NULL,'admin','fixture','fixture','fixture')"),
      db.prepare("INSERT INTO feature_flags VALUES ('flag','Fixture flag','Local only','paused','staging',0,'Owner','fixture')"),
      db.prepare("INSERT INTO workspaces VALUES ('fixture','Owner','Team','blocked','fixture')"),
      db.prepare("INSERT INTO run_reviews VALUES ('review','fixture','Preview','needs_approval',1,10,'fixture')"),
      db.prepare("INSERT INTO schema_tables VALUES ('table','fixture','fixture.orders','Fixture table',0,'fixture')"),
      db.prepare("INSERT INTO schema_fields VALUES ('field','table','contact','STRING','NULLABLE','Contact',1,0,0,'fixture')"),
      db.prepare("INSERT INTO audit_events VALUES ('audit','actor@example.test','fixture.action','fixture','{}','fixture')")
    ]);
  });
  afterAll(async () => {await mf?.dispose();});

  it("preserves stored list projections and restrictive field policy",async () => {
    const before = await snapshot(), state = await getAdminState({DB:db});
    expect(state.storage).toMatchObject({configured:true,mode:"d1",binding:"DB"});
    expect(state.users).toMatchObject([{id:"google:actor",role:"admin"}]);
    expect(state.featureFlags).toMatchObject([{id:"flag",rollout:0}]);
    expect(state.workspaceAllowlist).toMatchObject([{workspace:"fixture",runAccess:"blocked"}]);
    expect(state.reviewQueue).toMatchObject([{id:"review",status:"needs_approval"}]);
    expect(state.auditEvents).toMatchObject([{id:"audit",action:"fixture.action"}]);
    expect(state.schemaCatalog).toMatchObject([{id:"table",fields:[{id:"field",pii:true,queryable:false}]}]);
    expect(await getSchemaPolicyCatalog({DB:db})).toEqual({tables:state.schemaCatalog,source:"d1",storageBinding:"DB"});
    expect(await snapshot()).toEqual(before);
  });

  it.each(lists)("refuses an unconfirmed %s envelope after the native read",async table => {
    const before = await snapshot();
    await expect(getAdminState({DB:unconfirmedRead(table)})).rejects.toThrow("Admin read not confirmed");
    expect(await snapshot()).toEqual(before);
    expect((await getAdminState({DB:db})).schemaCatalog).toMatchObject([{fields:[{queryable:false}]}]);
  });

  it.each(["schema_tables","schema_fields"])("does not evaluate a policy with unconfirmed %s",async table => {
    const before = await snapshot();
    await expect(evaluateSchemaPolicy({DB:unconfirmedRead(table)},{workspace:"fixture",sql:"SELECT contact FROM fixture.orders"}))
      .rejects.toThrow("Admin read not confirmed");
    expect(await snapshot()).toEqual(before);
  });

  it("propagates a real missing-column SQL error without a partial catalog or repair",async () => {
    await db.prepare("ALTER TABLE schema_fields RENAME COLUMN queryable TO unavailable_queryable").run();
    const before = await snapshot();
    await expect(getSchemaPolicyCatalog({DB:db})).rejects.toThrow();
    await expect(getAdminState({DB:db})).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });
});
