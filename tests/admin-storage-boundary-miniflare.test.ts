import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { D1Database } from "../lib/d1";
import { ensureAdminSchema, getAdminState, getQueryRunDetail, getSchemaPolicyCatalog, upsertAuthenticatedUser } from "../lib/admin-store";

let mf: Miniflare, db: D1Database;
const tables = ["users","feature_flags","workspaces","run_reviews","query_runs","audit_events","schema_tables","schema_fields"];
const counts = async () => (await db.batch!(tables.map(table =>
  db.prepare(`SELECT '${table}' AS name, count(*) AS n FROM ${table}`))))
  .map(result => result.results![0]);
const snapshot = async () => (await db.batch!(tables.map(table => db.prepare(`SELECT * FROM ${table}`))))
  .map(result => result.results);

describe("administrator initialization on installed local D1",() => {
  beforeAll(async () => {
    mf = new Miniflare({host:"127.0.0.1",port:0,modules:true,
      script:"export default {fetch(){return new Response('Local admin storage test');}}",
      d1Databases:{DB:"local-admin-storage-boundary"},d1Persist:false});
    db = await mf.getD1Database("DB") as unknown as D1Database;
  },30000);
  beforeEach(async () => {
    for (const table of tables) await db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
  });
  afterAll(async () => {await mf?.dispose();});

  it("keeps fresh, repeated and concurrent initialization free of example records",async () => {
    await ensureAdminSchema(db);
    await Promise.all([ensureAdminSchema(db),ensureAdminSchema(db),ensureAdminSchema(db)]);
    expect(await counts()).toEqual(tables.map(name => ({name,n:0})));
  });

  it("returns stored empty dashboard and catalog views without recreating sample runs",async () => {
    const state = await getAdminState({DB:db});
    expect(state.storage).toMatchObject({configured:true,binding:"DB",mode:"d1"});
    for (const list of [state.users,state.featureFlags,state.workspaceAllowlist,state.reviewQueue,state.schemaCatalog,state.auditEvents]) {
      expect(list).toEqual([]);
    }
    expect(await getSchemaPolicyCatalog({DB:db})).toEqual({tables:[],source:"d1",storageBinding:"DB"});
    expect(await getQueryRunDetail({DB:db},"run-1027")).toMatchObject({ok:false,status:404});
    expect(await counts()).toEqual(tables.map(name => ({name,n:0})));
  });

  it("does not insert unrelated examples when persisting an authenticated synthetic user",async () => {
    expect(await upsertAuthenticatedUser({DB:db},{provider:"google",providerId:"local-test",email:"test@example.test",
      name:"Test",role:"member",expiresAt:4102444800000})).toMatchObject({persisted:true,role:"member"});
    expect(await counts()).toEqual(tables.map(name => ({name,n:name === "users" || name === "audit_events" ? 1 : 0})));
    expect(await db.prepare("SELECT action,target FROM audit_events").first()).toEqual({action:"auth.login",target:"google"});
  });

  it("preserves historical rows and edits under former example IDs without automatic cleanup",async () => {
    await ensureAdminSchema(db);
    await db.batch!([
      db.prepare("INSERT INTO users VALUES ('google:prior','google','prior','prior@example.test','Prior',NULL,'member','fixture','fixture','fixture')"),
      db.prepare("INSERT INTO feature_flags VALUES ('bigquery-run-gate','Edited flag','Existing description','paused','staging',0,'Owner','fixture')"),
      db.prepare("INSERT INTO workspaces VALUES ('demo','New owner','Pro','blocked','fixture')"),
      db.prepare("INSERT INTO run_reviews VALUES ('run-1027','demo','Edited preview','blocked',7,400,'fixture')"),
      db.prepare("INSERT INTO query_runs VALUES ('run-1027','demo',NULL,'SELECT 1','blocked','simulated',7,400,10,'[]','[]',NULL,'fixture','fixture')"),
      db.prepare("INSERT INTO audit_events VALUES ('prior','prior@example.test','prior.action','prior-target','{}','fixture')"),
      db.prepare("INSERT INTO schema_tables VALUES ('table-demo-orders','demo','demo.orders','Edited table',11,'fixture')"),
      db.prepare("INSERT INTO schema_fields VALUES ('table-demo-orders-order-id','table-demo-orders','order_id','INT64','REQUIRED','Edited field',1,0,0,'fixture')")
    ]);
    const before = await snapshot();
    await ensureAdminSchema(db);
    await getAdminState({DB:db});
    expect(await snapshot()).toEqual(before);
  });

  it("does not resurrect removed historical example IDs",async () => {
    await ensureAdminSchema(db);
    await db.prepare("INSERT INTO workspaces VALUES ('demo','Owner','Team','allowlisted','fixture')").run();
    await db.prepare("DELETE FROM workspaces WHERE workspace='demo'").run();
    await ensureAdminSchema(db);
    expect(await counts()).toEqual(tables.map(name => ({name,n:0})));
  });

  it("stops on a real DDL error and can resume empty partial initialization later",async () => {
    const broken: D1Database = {prepare:query => db.prepare(query.includes("CREATE TABLE IF NOT EXISTS workspaces (")
      ? "CREATE TABLE invalid_definition (" : query)};
    await expect(ensureAdminSchema(broken)).rejects.toThrow();
    const present = (await db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all<{name:string}>()).results!
      .map(row => row.name).filter(name => tables.includes(name));
    expect(present.sort()).toEqual(["feature_flags","users"]);
    await ensureAdminSchema(db);
    expect(await counts()).toEqual(tables.map(name => ({name,n:0})));
  });
});
