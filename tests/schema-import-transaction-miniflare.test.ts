import { Miniflare } from "miniflare";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureAdminSchema, importSchemaCatalog, type SchemaImportTableInput } from "../lib/admin-store";
import type { D1Database } from "../lib/d1";
import { importBigQuerySchemaCatalog } from "../lib/schema-import";
import * as bigquery from "../lib/bigquery";

let mf: Miniflare, db: D1Database;
const actor = {provider:"google" as const,providerId:"actor",email:"ACTOR@example.test"};
const input: {workspace:string;tables:SchemaImportTableInput[]} = {workspace:"fixture",tables:[
  {workspace:"fixture",name:"fixture.orders",description:"Updated orders",rowCount:9,fields:[
    {name:"contact",type:"STRING",mode:"NULLABLE",description:"Updated contact",pii:false,queryable:true},
    {name:"new_id",type:"INT64",mode:"REQUIRED"}
  ]},
  {workspace:"fixture",name:"fixture.lines",description:"New lines",rowCount:2,fields:[
    {name:"line_id",type:"INT64",mode:"REQUIRED"}
  ]}
]};
const submit = (database = db) => importSchemaCatalog({DB:database},input,actor);
const state = async () => (await db.batch!(["schema_tables","schema_fields","audit_events"].map(table =>
  db.prepare(`SELECT * FROM ${table} ORDER BY id`)))).map(result => result.results);

describe("schema import transaction on installed local D1",() => {
  beforeAll(async () => {
    mf = new Miniflare({host:"127.0.0.1",port:0,modules:true,
      script:"export default {fetch(){return new Response('Local schema import test');}}",
      d1Databases:{DB:"local-schema-import-transaction"},d1Persist:false});
    db = await mf.getD1Database("DB") as unknown as D1Database;
    await ensureAdminSchema(db);
  },30000);
  beforeEach(async () => {
    await db.prepare("DROP TRIGGER IF EXISTS failed_write").run();
    await db.prepare("DELETE FROM users").run();
    await db.prepare("INSERT INTO users VALUES ('google:actor','google','actor','ACTOR@example.test','Actor',NULL,'admin','prior','prior','prior')").run();
    for (const table of ["schema_fields","schema_tables","audit_events"]) await db.prepare(`DELETE FROM ${table}`).run();
    await db.prepare("INSERT INTO schema_tables VALUES ('legacy-orders','fixture','fixture.orders','Prior table',1,'prior')").run();
    await db.prepare("INSERT INTO schema_fields VALUES ('historical-contact','legacy-orders','contact','STRING','NULLABLE','Prior field',1,0,0,'prior')").run();
    await db.prepare("INSERT INTO audit_events VALUES ('prior-audit','prior@example.test','prior.action','prior','{}','prior')").run();
  });
  afterEach(() => {vi.restoreAllMocks();});
  afterAll(async () => {await mf?.dispose();});

  it("accepts the installed binding through the wrapper preflight and persists intercepted metadata",async () => {
    const query = vi.spyOn(bigquery,"runBigQueryQuery").mockResolvedValue({ok:true,totalRows:1,rows:[{
      table_catalog:"fixture-project",table_schema:"fixture",table_name:"orders",table_type:"BASE TABLE",
      column_name:"contact",data_type:"STRING",is_nullable:"YES",ordinal_position:1,policy_tags:null
    }]});
    expect(await importBigQuerySchemaCatalog({DB:db,GATEWAY_MODE:"demo"},
      {workspace:"fixture",dataset:"fixture",projectId:"fixture-project"},actor))
      .toMatchObject({ok:true,value:{importedTables:1,importedFields:1,projectId:"fixture-project",dataset:"fixture"}});
    expect(query).toHaveBeenCalledTimes(1);
    const [tables,fields,audits] = await state();
    expect(tables).toHaveLength(1);
    expect(fields).toMatchObject([{id:"historical-contact",table_id:"legacy-orders",pii:1,queryable:0}]);
    expect(audits).toHaveLength(2);
  });

  it("refuses a wrapper without batch before provider work or any native catalog change",async () => {
    const query = vi.spyOn(bigquery,"runBigQueryQuery").mockRejectedValue(new Error("Unexpected provider call"));
    const prepare = vi.fn((sql: string) => db.prepare(sql)), before = await state();
    expect(await importBigQuerySchemaCatalog({DB:{prepare},GATEWAY_MODE:"demo"},
      {workspace:"fixture",dataset:"fixture",projectId:"fixture-project"},actor))
      .toMatchObject({ok:false,status:503,code:"schema_import_transaction_unavailable"});
    expect(query).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(await state()).toEqual(before);
  });

  it("commits the complete catalog and audit while preserving existing IDs and policy",async () => {
    const result = await submit();
    expect(result).toMatchObject({ok:true,value:{importedTables:2,importedFields:3}});
    if (!result.ok) throw new Error("Expected confirmed import");
    const [tables,fields,audits] = await state();
    expect(tables).toHaveLength(2);
    expect(tables).toContainEqual({id:"legacy-orders",workspace:"fixture",table_name:"fixture.orders",
      description:"Updated orders",row_count:9,updated_at:result.value.importedAt});
    expect(fields).toHaveLength(3);
    expect(fields).toContainEqual(expect.objectContaining({id:"historical-contact",table_id:"legacy-orders",
      description:"Updated contact",pii:1,queryable:0}));
    expect(fields).toContainEqual(expect.objectContaining({table_id:"table-fixture-lines",field_name:"line_id"}));
    expect(audits).toHaveLength(2);
    expect(audits).toContainEqual(expect.objectContaining({actor_email:"actor@example.test",action:"schema_catalog.imported",
      target:"fixture",metadata_json:'{"importedTables":2,"importedFields":3}',created_at:result.value.importedAt}));
  });

  it.each([
    ["BEFORE INSERT ON schema_tables","ABORT"],["BEFORE UPDATE ON schema_tables","ABORT"],
    ["BEFORE INSERT ON schema_fields WHEN NEW.field_name='line_id'","ABORT"],
    ["BEFORE UPDATE ON schema_fields","ABORT"],["BEFORE INSERT ON audit_events","ABORT"],
    ["BEFORE INSERT ON schema_tables","IGNORE"],["BEFORE UPDATE ON schema_tables","IGNORE"],
    ["BEFORE INSERT ON schema_fields WHEN NEW.field_name='line_id'","IGNORE"],
    ["BEFORE UPDATE ON schema_fields","IGNORE"],["BEFORE INSERT ON audit_events","IGNORE"]
  ])("rolls back every import write for %s with %s",async (clause,mode) => {
    await db.prepare(`CREATE TRIGGER failed_write ${clause}
      BEGIN SELECT RAISE(${mode}${mode === "ABORT" ? ",'synthetic failure'" : ""}); END`).run();
    const before = await state();
    await expect(submit()).rejects.toThrow();
    expect(await state()).toEqual(before);
  });

  it.each([false,true])("preserves an existing audit on ID collision, ignored=%s",async ignored => {
    if (ignored) await db.prepare("CREATE TRIGGER failed_write BEFORE INSERT ON audit_events BEGIN SELECT RAISE(IGNORE); END").run();
    vi.spyOn(crypto,"randomUUID").mockReturnValue("prior-audit");
    const before = await state();
    await expect(submit()).rejects.toThrow();
    expect(await state()).toEqual(before);
  });

  it("rejects a table-ID race without retaining earlier writes or changing the concurrent table",async () => {
    let concurrent: Awaited<ReturnType<typeof state>>;
    const batch = vi.fn(async (statements: Parameters<NonNullable<D1Database["batch"]>>[0]) => {
      await db.prepare("INSERT INTO schema_tables VALUES ('concurrent-lines','fixture','fixture.lines','Concurrent table',3,'concurrent')").run();
      concurrent = await state();
      return db.batch!(statements);
    });
    await expect(submit({prepare:query => db.prepare(query),batch})).rejects.toThrow();
    expect(batch).toHaveBeenCalledTimes(1);
    expect(await state()).toEqual(concurrent!);
    expect(await submit()).toMatchObject({ok:true});
    expect(await db.prepare("SELECT table_id FROM schema_fields WHERE field_name='line_id'").first())
      .toEqual({table_id:"concurrent-lines"});
  });

  it("does not retry or delete committed catalog records after a lost acknowledgment",async () => {
    const batch = vi.fn(async (statements: Parameters<NonNullable<D1Database["batch"]>>[0]) => {
      await db.batch!(statements);
      throw new Error("Synthetic lost acknowledgment");
    });
    await expect(submit({prepare:query => db.prepare(query),batch})).rejects.toThrow("Synthetic lost acknowledgment");
    expect(batch).toHaveBeenCalledTimes(1);
    const [tables,fields,audits] = await state();
    expect(tables).toHaveLength(2);
    expect(fields).toHaveLength(3);
    expect(audits).toHaveLength(2);
  });

  it.each([
    "UPDATE users SET role='member' WHERE id='google:actor'",
    "DELETE FROM users WHERE id='google:actor'",
    "UPDATE users SET id='google:replacement' WHERE id='google:actor'",
    "UPDATE users SET provider='github' WHERE id='google:actor'",
    "UPDATE users SET provider_id='replacement' WHERE id='google:actor'",
    "UPDATE users SET email='renamed@example.test' WHERE id='google:actor'"
  ])("refuses changed canonical authority before native batch execution: %s",async change => {
    let concurrent: Awaited<ReturnType<typeof state>>;
    const batch = vi.fn(async (statements: Parameters<NonNullable<D1Database["batch"]>>[0]) => {
      await db.prepare(change).run();
      concurrent = await state();
      return db.batch!(statements);
    });
    expect(await submit({prepare:query => db.prepare(query),batch}))
      .toMatchObject({ok:false,status:403,code:"schema_import_denied"});
    expect(batch).toHaveBeenCalledTimes(1);
    expect(await state()).toEqual(concurrent!);
  });

  it.each([false,true])("never deletes a colliding historical audit after revocation, ignored=%s",async ignored => {
    if (ignored) await db.prepare("CREATE TRIGGER failed_write BEFORE INSERT ON audit_events BEGIN SELECT RAISE(IGNORE); END").run();
    vi.spyOn(crypto,"randomUUID").mockReturnValue("prior-audit");
    const before = await state();
    const batch = vi.fn(async (statements: Parameters<NonNullable<D1Database["batch"]>>[0]) => {
      await db.prepare("UPDATE users SET role='member' WHERE id='google:actor'").run();
      return db.batch!(statements);
    });
    await expect(submit({prepare:query => db.prepare(query),batch})).rejects.toThrow();
    expect(batch).toHaveBeenCalledTimes(1);
    expect(await state()).toEqual(before);
  });

  it("rolls back the audit and earlier catalog writes if an in-batch change revokes authority",async () => {
    await db.prepare("CREATE TRIGGER failed_write AFTER UPDATE ON schema_tables BEGIN UPDATE users SET role='member' WHERE id='google:actor'; END").run();
    const before = await state();
    await expect(submit()).rejects.toThrow();
    expect(await state()).toEqual(before);
    expect(await db.prepare("SELECT role FROM users WHERE id='google:actor'").first()).toEqual({role:"admin"});
  });
});
