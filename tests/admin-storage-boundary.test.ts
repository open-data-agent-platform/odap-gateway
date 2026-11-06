import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { D1Database, D1Result } from "../lib/d1";
import { ensureAdminSchema, getAdminState, getQueryRunDetail, getSchemaPolicyCatalog,
  updateFeatureRollout, upsertAuthenticatedUser } from "../lib/admin-store";
import { jobSqlite, jobTransactionalDatabase } from "./fixtures/job-sqlite";

const tables = ["users","feature_flags","workspaces","run_reviews","query_runs","audit_events","schema_tables","schema_fields"];
const directories: string[] = [];
async function database() {
  const dir = await mkdtemp(join(tmpdir(),"odap-admin-boundary-"));
  directories.push(dir);
  const file = join(dir,"fixture.sqlite");
  return {file,db:jobTransactionalDatabase(() => file)};
}
const counts = async (db: D1Database) => (await db.prepare(tables.map(table =>
  `SELECT '${table}' AS name, count(*) AS n FROM ${table}`).join(" UNION ALL ")).all()).results;

function fakeDatabase() {
  const run = vi.fn(async (query: string): Promise<D1Result> => {
    if (!query.trim()) throw new Error("Empty fixture statement");
    return {success:true};
  });
  const all = vi.fn(async () => ({success:true,results:[]}));
  const first = vi.fn(async () => null);
  const batch = vi.fn(async () => []);
  const prepare = vi.fn((query: string) => {
    const statement = {bind:() => statement,run:() => run(query),all,first};
    return statement;
  });
  return {db:{prepare,batch} as D1Database,run,all,first,batch,prepare};
}

describe("administrator storage initialization boundary",() => {
  afterAll(async () => {for (const dir of directories) await rm(dir,{recursive:true,force:true});});

  it("baseline: refuses an unconfirmed table creation",async () => {
    const fixture = fakeDatabase();
    fixture.run.mockResolvedValue({success:false});
    await expect(ensureAdminSchema(fixture.db)).rejects.toThrow();
    expect(fixture.run).toHaveBeenCalledTimes(1);
  });

  it("baseline: initializes real storage without inserting demonstration records",async () => {
    const {db} = await database();
    await ensureAdminSchema(db);
    expect(await counts(db)).toEqual(tables.map(name => ({name,n:0})));
  },20000);

  it("baseline: installs an empty schema without demonstration access or approvals",async () => {
    const {db,file} = await database();
    await jobSqlite(file,"apply-legacy-schema");
    expect(await counts(db)).toEqual(tables.map(name => ({name,n:0})));
  },20000);

  it.each(tables)("requires an affirmative acknowledgment for %s",async table => {
    for (const result of [{success:false},{}]) {
      const fixture = fakeDatabase();
      fixture.run.mockImplementation(async query => query.includes(`CREATE TABLE IF NOT EXISTS ${table} (`) ? result : {success:true});
      await expect(ensureAdminSchema(fixture.db)).rejects.toThrow("Admin table creation not confirmed");
      expect(fixture.run).toHaveBeenCalledTimes(tables.indexOf(table)+1);
      expect(fixture.all).not.toHaveBeenCalled();
    }
  });

  it.each(tables)("propagates a %s creation failure and stops later statements",async table => {
    const fixture = fakeDatabase(), failure = new Error("Synthetic DDL failure");
    fixture.run.mockImplementation(async query => {
      if (query.includes(`CREATE TABLE IF NOT EXISTS ${table} (`)) throw failure;
      return {success:true};
    });
    await expect(ensureAdminSchema(fixture.db)).rejects.toBe(failure);
    expect(fixture.run).toHaveBeenCalledTimes(tables.indexOf(table)+1);
  });

  it("runs only the eight table definitions and does not seed, update or delete content",async () => {
    const fixture = fakeDatabase();
    await ensureAdminSchema(fixture.db);
    expect(fixture.run).toHaveBeenCalledTimes(8);
    expect(fixture.prepare.mock.calls.every(([query]) => query.startsWith("CREATE TABLE IF NOT EXISTS "))).toBe(true);
    expect(fixture.batch).not.toHaveBeenCalled();
  });

  it.each(["dashboard","catalog","run detail","login","rollout"])("blocks %s after initialization refusal without switching bindings",async operation => {
    const fixture = fakeDatabase(), fallback = fakeDatabase();
    fixture.run.mockResolvedValue({success:false});
    const env = {ODAP_GATEWAY_DB:fixture.db,DB:fallback.db};
    const actor = {provider:"google" as const,providerId:"actor",email:"actor@example.test"};
    const action = operation === "dashboard" ? getAdminState(env)
      : operation === "catalog" ? getSchemaPolicyCatalog(env)
      : operation === "run detail" ? getQueryRunDetail(env,"run-1027")
      : operation === "rollout" ? updateFeatureRollout(env,"bigquery-run-gate",100,actor)
      : upsertAuthenticatedUser(env,{...actor,name:"Actor",role:"member",expiresAt:4102444800000});
    await expect(action).rejects.toThrow("Admin table creation not confirmed");
    expect(fixture.all).not.toHaveBeenCalled();
    expect(fixture.first).not.toHaveBeenCalled();
    expect(fixture.batch).not.toHaveBeenCalled();
    expect(fallback.prepare).not.toHaveBeenCalled();
  });

  it("keeps confirmed empty dashboard and catalog results empty",async () => {
    const {db} = await database();
    const state = await getAdminState({DB:db});
    expect(state.storage).toMatchObject({configured:true,mode:"d1",binding:"DB"});
    for (const list of [state.users,state.featureFlags,state.workspaceAllowlist,state.reviewQueue,state.schemaCatalog,state.auditEvents]) {
      expect(list).toEqual([]);
    }
    expect(await getSchemaPolicyCatalog({DB:db})).toEqual({source:"d1",storageBinding:"DB",tables:[]});
    expect(await getQueryRunDetail({DB:db},"run-1027")).toMatchObject({ok:false,status:404});
    expect(await counts(db)).toEqual(tables.map(name => ({name,n:0})));
  },20000);

  it("retains a stored former-example ID with edits, and does not recreate it after removal",async () => {
    const {db,file} = await database();
    await ensureAdminSchema(db);
    await jobSqlite(file,"run",`INSERT INTO feature_flags VALUES
      ('bigquery-run-gate','Reviewed flag','Existing edited description','paused','staging',0,'Local owner','fixture')`);
    const before = await db.prepare("SELECT * FROM feature_flags").all();
    await ensureAdminSchema(db);
    expect(await db.prepare("SELECT * FROM feature_flags").all()).toEqual(before);
    await jobSqlite(file,"run","DELETE FROM feature_flags WHERE id='bigquery-run-gate'");
    await ensureAdminSchema(db);
    expect(await counts(db)).toEqual(tables.map(name => ({name,n:0})));
  },20000);

  it("retains the separately marked no-storage preview without claiming persistence",async () => {
    const state = await getAdminState({});
    expect(state.storage).toMatchObject({configured:false,binding:null,mode:"seed"});
    expect(state.featureFlags.length).toBeGreaterThan(0);
    expect((await getSchemaPolicyCatalog({})).source).toBe("seed");
  });
});
