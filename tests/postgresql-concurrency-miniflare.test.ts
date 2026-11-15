import { Miniflare } from "miniflare";
import { beforeAll, beforeEach, afterAll, describe } from "vitest";
import type { D1Database } from "../lib/d1";
import { jobSqlite } from "./fixtures/job-sqlite";
import { seedPostgresControl } from "./fixtures/postgresql-control";
import { postgresConcurrencyCases } from "./fixtures/postgresql-concurrency-cases";

let mf: Miniflare, db: D1Database, statements: string[], sequence = 0;
describe("PostgreSQL durable concurrency on native D1", { timeout: 30000 }, () => {
  beforeAll(async () => { statements = await jobSqlite(":memory:", "migration-statements"); });
  beforeEach(async () => {
    await mf?.dispose();
    mf = new Miniflare({ host: "127.0.0.1", port: 0, modules: true,
      script: "export default {fetch(){return new Response('Local PG resource control');}}",
      d1Databases: { DB: "pg-resource-" + (++sequence) }, d1Persist: false });
    db = await mf.getD1Database("DB") as unknown as D1Database;
    await db.batch!(statements.map(sql => db.prepare(sql))); await seedPostgresControl(db, undefined, 10, undefined, null);
  }, 30000);
  afterAll(async () => { await mf?.dispose(); });
  postgresConcurrencyCases(() => db);
});
