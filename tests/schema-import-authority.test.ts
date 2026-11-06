import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionCookie, signAuthPayload } from "../lib/auth";
import * as bigquery from "../lib/bigquery";
import { jobSqlite, jobTransactionalDatabase } from "./fixtures/job-sqlite";
import worker from "../worker";
import { withBodyReadHook } from "./fixtures/request-body-hook";

let dir: string, file: string, baseline: string, cookie: string;
let beforeWrite: (() => Promise<void>) | null = null;
const base = jobTransactionalDatabase(() => file);
const db = {...base,batch:async (statements: Parameters<NonNullable<typeof base.batch>>[0]) => {
  const hook = beforeWrite;
  beforeWrite = null;
  await hook?.();
  return base.batch!(statements);
}};
const env = {AUTH_COOKIE_SECRET:"synthetic-schema-import-authority",GATEWAY_MODE:"demo" as const,DB:db,
  ASSETS:{fetch:async () => {throw new Error("Unexpected assets");}}};
const sql = (query: string) => jobSqlite(file,"run",query);
const metadata = {ok:true as const,totalRows:2,rows:["orders","lines"].map(table => ({
  table_catalog:"fixture-project",table_schema:"fixture",table_name:table,table_type:"BASE TABLE",
  column_name:"contact",data_type:"STRING",is_nullable:"YES",ordinal_position:1,policy_tags:null
}))};
const request = () => new Request("https://gateway.test/api/admin/schema-import",{
  method:"POST",headers:{Cookie:cookie,Origin:"https://gateway.test","Content-Type":"application/json"},body:JSON.stringify({projectId:"fixture-project",dataset:"fixture",workspace:"fixture"})
});
const submit = (input = request()) => worker.fetch(input,env,{waitUntil:() => {throw new Error("Unexpected background task");}});
async function denied(response: Response, snapshot: Buffer) {
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ok:false,code:"schema_import_denied"});
  expect((await readFile(file)).equals(snapshot)).toBe(true);
  expect(fetch).not.toHaveBeenCalled();
}

describe("write-time administrator authority for schema import",() => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(),"odap-import-authority-"));
    file = baseline = join(dir,"baseline.sqlite");
    await jobSqlite(file,"apply-legacy-schema");
    await sql("INSERT INTO users VALUES ('google:actor','google','actor','actor@example.test','Actor',NULL,'admin','prior','prior','prior')");
    await sql("INSERT INTO schema_tables VALUES ('legacy-orders','fixture','fixture.orders','Prior table',1,'prior')");
    await sql("INSERT INTO schema_fields VALUES ('historical-contact','legacy-orders','contact','STRING','NULLABLE','Prior field',1,0,0,'prior')");
    await sql("INSERT INTO audit_events VALUES ('prior-audit','prior@example.test','prior.action','prior','{}','prior')");
    cookie = createSessionCookie(await signAuthPayload({provider:"google",providerId:"actor",email:"actor@example.test",
      role:"admin",name:"Actor",expiresAt:Date.now()+600000},env.AUTH_COOKIE_SECRET));
  },20000);
  beforeEach(async () => {
    file = join(dir,"case.sqlite");
    await copyFile(baseline,file);
    beforeWrite = null;
    vi.stubGlobal("fetch",vi.fn(async () => {throw new Error("Unexpected network call");}));
    vi.spyOn(console,"error").mockImplementation(() => {});
    vi.spyOn(bigquery,"runBigQueryQuery").mockResolvedValue(metadata);
  });
  afterEach(() => {vi.restoreAllMocks();vi.unstubAllGlobals();});
  afterAll(async () => {if (dir) await rm(dir,{recursive:true,force:true});});

  it("baseline: refuses an administrator demoted during body parsing",async () => {
    let snapshot!: Buffer;
    const revoke = vi.fn(async () => {
      await sql("UPDATE users SET role='member' WHERE id='google:actor'");
      snapshot = await readFile(file);
    });
    await denied(await submit(withBodyReadHook(request(), revoke)),snapshot);
    expect(revoke).toHaveBeenCalledOnce();
  });

  it("baseline: refuses an administrator removed while metadata is retrieved",async () => {
    let snapshot!: Buffer;
    vi.mocked(bigquery.runBigQueryQuery).mockImplementationOnce(async () => {
      await sql("DELETE FROM users WHERE id='google:actor'");
      snapshot = await readFile(file);
      return metadata;
    });
    await denied(await submit(),snapshot);
  });

  it("baseline: refuses a rebound subject after catalog lookup and before transaction submission",async () => {
    let snapshot!: Buffer;
    beforeWrite = async () => {
      await sql("UPDATE users SET provider_id='replacement' WHERE id='google:actor'");
      snapshot = await readFile(file);
    };
    await denied(await submit(),snapshot);
    expect(beforeWrite).toBeNull();
  });

  it.each([
    ["role","UPDATE users SET role='member' WHERE id='google:actor'"],
    ["removal","DELETE FROM users WHERE id='google:actor'"],
    ["canonical ID","UPDATE users SET id='google:replacement' WHERE id='google:actor'"],
    ["provider","UPDATE users SET provider='github' WHERE id='google:actor'"],
    ["subject","UPDATE users SET provider_id='replacement' WHERE id='google:actor'"],
    ["audit contact","UPDATE users SET email='renamed@example.test' WHERE id='google:actor'"]
  ])("refuses changed %s inside the final write boundary",async (_label,change) => {
    let snapshot!: Buffer;
    beforeWrite = async () => {await sql(change);snapshot = await readFile(file);};
    await denied(await submit(),snapshot);
  });

  it("does not borrow a replacement administrator with the same email",async () => {
    let snapshot!: Buffer;
    beforeWrite = async () => {
      await sql("DELETE FROM users WHERE id='google:actor'");
      await sql("INSERT INTO users VALUES ('github:other','github','other','actor@example.test','Other',NULL,'admin','prior','prior','prior')");
      snapshot = await readFile(file);
    };
    await denied(await submit(),snapshot);
  });

  it("uses the current stored audit contact rather than the cookie contact",async () => {
    await sql("UPDATE users SET email='CURRENT@example.test' WHERE id='google:actor'");
    const response = await submit();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ok:true,import:{importedTables:2,importedFields:2}});
    expect(await jobSqlite(file,"readonly-first","SELECT actor_email,metadata_json FROM audit_events WHERE action='schema_catalog.imported'"))
      .toEqual({actor_email:"current@example.test",metadata_json:'{"importedTables":2,"importedFields":2}'});
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([[false,false],[false,true],[true,false],[true,true]])(
    "preserves a historical audit collision with revoked=%s and ignored=%s",async (revoked,ignored) => {
      if (ignored) await sql("CREATE TRIGGER failed_write BEFORE INSERT ON audit_events BEGIN SELECT RAISE(IGNORE); END");
      vi.spyOn(crypto,"randomUUID").mockReturnValue("prior-audit");
      let snapshot!: Buffer;
      beforeWrite = async () => {
        if (revoked) await sql("UPDATE users SET role='member' WHERE id='google:actor'");
        snapshot = await readFile(file);
      };
      const response = await submit();
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({ok:false,code:"internal_error"});
      expect((await readFile(file)).equals(snapshot)).toBe(true);
    });

  it("rolls back earlier writes if authority changes within the transaction",async () => {
    await sql("CREATE TRIGGER revoke_actor AFTER UPDATE ON schema_tables BEGIN UPDATE users SET role='member' WHERE id='google:actor'; END");
    const snapshot = await readFile(file), response = await submit();
    expect(response.status).toBe(500);
    expect((await readFile(file)).equals(snapshot)).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });
});
