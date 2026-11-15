import { Miniflare } from "miniflare";
import { beforeAll, beforeEach, afterAll, describe } from "vitest";
import type { D1Database } from "../lib/d1";
import { jobSqlite } from "./fixtures/job-sqlite";
import { seedPostgresControl } from "./fixtures/postgresql-control";
import { postgresCancellationCases } from "./fixtures/postgresql-cancellation-cases";

let mf: Miniflare, db: D1Database, statements: string[], sequence = 0;
describe("PostgreSQL cancellation intent on native D1", { timeout: 30000 }, () => {
  beforeAll(async () => { statements = await jobSqlite(":memory:", "migration-statements"); });
  beforeEach(async () => {
    await mf?.dispose();
    mf = new Miniflare({ host: "127.0.0.1", port: 0, modules: true,
      script: "export default {fetch(){return new Response('Local PG cancellation control');}}",
      d1Databases: { DB: "pg-cancel-" + (++sequence) }, d1Persist: false });
    db = await mf.getD1Database("DB") as unknown as D1Database;
    await db.batch!(statements.map(sql => db.prepare(sql))); await seedPostgresControl(db);
  }, 30000);
  afterAll(async () => { await mf?.dispose(); });
  postgresCancellationCases(() => db);
});
