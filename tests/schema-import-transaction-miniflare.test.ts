import { Miniflare } from "miniflare";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureAdminSchema, importSchemaCatalog, type SchemaImportTableInput } from "../lib/admin-store";
import type { D1Database } from "../lib/d1";
import { importBigQuerySchemaCatalog } from "../lib/schema-import";
import * as bigquery from "../lib/bigquery";
import { evaluateSchemaPolicy } from "../lib/schema-policy";

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

  it.each([
    ["source project", { table_catalog: "other-project" }],
    ["source dataset", { table_schema: "other_dataset" }],
    ["table prefix", { table_name: "payments" }],
    ["invalid column", { column_name: "" }],
    ["policy metadata", { policy_tags: false }],
    ["duplicate column", { column_name: "contact" }],
    ["table count", { table_name: "orders_archive" }]
  ] satisfies Array<[string, bigquery.BigQueryQueryRow]>)("rejects %s without any native catalog or audit change", async (_name, patch) => {
    const good = { table_catalog: "fixture-project", table_schema: "fixture", table_name: "orders", table_type: "BASE TABLE",
      column_name: "contact", data_type: "STRING", is_nullable: "YES", ordinal_position: 1, policy_tags: null };
    const query = vi.spyOn(bigquery, "runBigQueryQuery").mockResolvedValue({ ok: true, totalRows: 2,
      rows: [good, { ...good, column_name: "new_column", ordinal_position: 2, ...patch }] });
    const before = await state(), prepare = vi.fn((sql: string) => db.prepare(sql));
    const batch = vi.fn((statements: Parameters<NonNullable<D1Database["batch"]>>[0]) => db.batch!(statements));
    expect(await importBigQuerySchemaCatalog({ DB: { prepare, batch }, GATEWAY_MODE: "demo" },
      { workspace: "fixture", projectId: "fixture-project", dataset: "fixture", tablePrefix: "ord", tableLimit: 1 }, actor))
      .toEqual({ ok: false, status: 500, code: "schema_import_metadata_invalid",
        message: "BigQuery schema metadata did not match the requested import." });
    expect(query).toHaveBeenCalledTimes(1);
    expect(prepare).not.toHaveBeenCalled();
    expect(batch).not.toHaveBeenCalled();
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

  it.each([[0, 1], [1, 1], [0, 0], [1, 0]])(
    "tightens tagged reimports from pii=%i/queryable=%i and never reopens them after tag removal", async (pii, queryable) => {
      await db.prepare("UPDATE schema_fields SET pii=?,queryable=? WHERE id='historical-contact'").bind(pii, queryable).run();
      const metadata = { table_catalog: "fixture-project", table_schema: "fixture", table_name: "orders",
        table_type: "BASE TABLE", column_name: "contact", data_type: "STRING", is_nullable: "YES", ordinal_position: 1,
        policy_tags: "projects/fixture/locations/us/taxonomies/1/policyTags/2" };
      const query = vi.spyOn(bigquery, "runBigQueryQuery")
        .mockResolvedValueOnce({ ok: true, totalRows: 1, rows: [metadata] })
        .mockResolvedValueOnce({ ok: true, totalRows: 1, rows: [{ ...metadata, policy_tags: null }] });
      const request = { workspace: "fixture", dataset: "fixture", projectId: "fixture-project" };
      const policyInput = { workspace: "fixture", sql: "SELECT contact FROM `fixture.orders`" };
      expect((await evaluateSchemaPolicy({ DB: db }, policyInput)).blocked).toBe(pii === 1 || queryable === 0);
      expect(await importBigQuerySchemaCatalog({ DB: db, GATEWAY_MODE: "demo" }, request, actor)).toMatchObject({ ok: true });
      const restriction = await db.prepare("SELECT id,pii,queryable FROM schema_fields WHERE field_name='contact'").first();
      expect(restriction).toEqual({ id: "historical-contact", pii: 1, queryable: 0 });
      const policy = await evaluateSchemaPolicy({ DB: db }, policyInput);
      expect(policy.blocked).toBe(true);
      expect(policy.reasons.join(" ")).toContain("fixture.orders.contact is not queryable");
      const audit = await db.prepare("SELECT metadata_json FROM audit_events WHERE action='schema_catalog.imported'")
        .first<{ metadata_json: string }>();
      expect(JSON.parse(audit!.metadata_json)).toEqual({ importedTables: 1, importedFields: 1,
        requestedRestrictions: [{ table: "fixture.orders", field: "contact", pii: true, queryable: false }] });
      expect(audit!.metadata_json).not.toContain(metadata.policy_tags);
      expect(await importBigQuerySchemaCatalog({ DB: db, GATEWAY_MODE: "demo" }, request, actor)).toMatchObject({ ok: true });
      expect(await db.prepare("SELECT id,pii,queryable FROM schema_fields WHERE field_name='contact'").first()).toEqual(restriction);
      expect((await evaluateSchemaPolicy({ DB: db }, policyInput)).blocked).toBe(true);
      expect(query).toHaveBeenCalledTimes(2);
      expect(await db.prepare("SELECT count(*) n FROM audit_events WHERE action='schema_catalog.imported'").first()).toEqual({ n: 2 });
    });

  it.each([
    [{ pii: true }, 1, 1], [{ queryable: false }, 0, 0],
    [{ pii: false, queryable: true }, 0, 1], [{}, 0, 1]
  ] satisfies Array<[Partial<SchemaImportTableInput["fields"][number]>, number, number]>)(
    "applies only explicit restrictions %j without reapplying name heuristics", async (flags, pii, queryable) => {
      await db.prepare("UPDATE schema_fields SET field_name='email',pii=0,queryable=1 WHERE id='historical-contact'").run();
      const reimport = structuredClone(input);
      reimport.tables = [reimport.tables[0]];
      reimport.tables[0].fields = [{ name: "email", type: "STRING", mode: "NULLABLE", ...flags },
        { name: "phone", type: "STRING", mode: "NULLABLE" }];
      expect(await importSchemaCatalog({ DB: db }, reimport, actor)).toMatchObject({ ok: true });
      expect(await db.prepare("SELECT id,pii,queryable FROM schema_fields WHERE field_name='email'").first())
        .toEqual({ id: "historical-contact", pii, queryable });
      expect(await db.prepare("SELECT pii,queryable FROM schema_fields WHERE field_name='phone'").first())
        .toEqual({ pii: 1, queryable: 0 });
    });

  it.each(["ABORT", "IGNORE"])("rolls back new restrictions and their audit when a later write uses %s", async mode => {
    await db.prepare("UPDATE schema_fields SET pii=0,queryable=1 WHERE id='historical-contact'").run();
    await db.prepare(`CREATE TRIGGER failed_write BEFORE INSERT ON schema_fields WHEN NEW.field_name='line_id'
      BEGIN SELECT RAISE(${mode}${mode === "ABORT" ? ",'synthetic restriction failure'" : ""}); END`).run();
    const reimport = structuredClone(input);
    Object.assign(reimport.tables[0].fields[0], { pii: true, queryable: false });
    const before = await state();
    await expect(importSchemaCatalog({ DB: db }, reimport, actor)).rejects.toThrow();
    expect(await state()).toEqual(before);
  });

  it("merges restrictions with the current field policy at transaction execution", async () => {
    await db.prepare("UPDATE schema_fields SET pii=0,queryable=1 WHERE id='historical-contact'").run();
    const reimport = structuredClone(input);
    reimport.tables[0].fields[0].pii = true;
    const batch = vi.fn(async (statements: Parameters<NonNullable<D1Database["batch"]>>[0]) => {
      await db.prepare("UPDATE schema_fields SET queryable=0 WHERE id='historical-contact'").run();
      return db.batch!(statements);
    });
    expect(await importSchemaCatalog({ DB: { prepare: query => db.prepare(query), batch } }, reimport, actor)).toMatchObject({ ok: true });
    expect(await db.prepare("SELECT id,pii,queryable FROM schema_fields WHERE field_name='contact'").first())
      .toEqual({ id: "historical-contact", pii: 1, queryable: 0 });
    expect(batch).toHaveBeenCalledTimes(1);
  });

  it("does not undo a committed restriction when its acknowledgment is lost", async () => {
    await db.prepare("UPDATE schema_fields SET pii=0,queryable=1 WHERE id='historical-contact'").run();
    const reimport = structuredClone(input);
    Object.assign(reimport.tables[0].fields[0], { pii: true, queryable: false });
    const batch = vi.fn(async (statements: Parameters<NonNullable<D1Database["batch"]>>[0]) => {
      await db.batch!(statements);
      throw new Error("Synthetic lost restriction acknowledgment");
    });
    await expect(importSchemaCatalog({ DB: { prepare: query => db.prepare(query), batch } }, reimport, actor))
      .rejects.toThrow("Synthetic lost restriction acknowledgment");
    expect(await db.prepare("SELECT pii,queryable FROM schema_fields WHERE field_name='contact'").first())
      .toEqual({ pii: 1, queryable: 0 });
    expect(await db.prepare("SELECT count(*) n FROM audit_events WHERE action='schema_catalog.imported'").first()).toEqual({ n: 1 });
    expect(batch).toHaveBeenCalledTimes(1);
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
