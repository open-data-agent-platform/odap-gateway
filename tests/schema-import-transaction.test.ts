import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { importSchemaCatalog, type SchemaImportTableInput } from "../lib/admin-store";
import { jobSqlite, jobTransactionalDatabase } from "./fixtures/job-sqlite";

let dir: string, file: string, baseline: string;
const base = jobTransactionalDatabase(() => file), db = {...base,batch:base.batch!};
const actor = {provider:"google" as const,providerId:"actor",email:"ACTOR@example.test"};
const input: {workspace:string;tables:SchemaImportTableInput[]} = {workspace:"fixture",tables:[
  {workspace:"fixture",name:"fixture.orders",description:"Updated orders",rowCount:9,fields:[
    {name:"contact",type:"STRING",mode:"NULLABLE",description:"Updated contact",pii:false,queryable:true,usedInExamples:true},
    {name:"new_id",type:"INT64",mode:"REQUIRED"}
  ]},
  {workspace:"fixture",name:"fixture.lines",description:"New lines",rowCount:2,fields:[
    {name:"line_id",type:"INT64",mode:"REQUIRED"}
  ]}
]};
const sql = (query: string) => jobSqlite(file,"run",query);
const submit = () => importSchemaCatalog({DB:db},input,actor);
const counts = async () => ({
  tables:await jobSqlite(file,"readonly-first","SELECT count(*) n FROM schema_tables"),
  fields:await jobSqlite(file,"readonly-first","SELECT count(*) n FROM schema_fields"),
  audits:await jobSqlite(file,"readonly-first","SELECT count(*) n FROM audit_events WHERE action='schema_catalog.imported'")
});

describe("atomic schema import storage",() => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(),"odap-schema-import-transaction-"));
    file = baseline = join(dir,"baseline.sqlite");
    await jobSqlite(file,"apply-legacy-schema");
    await sql("INSERT INTO users VALUES ('google:actor','google','actor','ACTOR@example.test','Actor',NULL,'admin','prior','prior','prior')");
    await sql("INSERT INTO schema_tables VALUES ('legacy-orders','fixture','fixture.orders','Prior table',1,'prior')");
    await sql("INSERT INTO schema_fields VALUES ('historical-contact','legacy-orders','contact','STRING','NULLABLE','Prior field',1,0,0,'prior')");
    await sql("INSERT INTO audit_events VALUES ('prior-audit','prior@example.test','prior.action','prior','{}','prior')");
  },20000);
  beforeEach(async () => {
    file = join(dir,"case.sqlite");
    await copyFile(baseline,file);
    vi.stubGlobal("fetch",vi.fn(async () => {throw new Error("Unexpected network call");}));
  });
  afterEach(() => {vi.restoreAllMocks();vi.unstubAllGlobals();});
  afterAll(async () => {if (dir) await rm(dir,{recursive:true,force:true});});

  it("baseline: rolls back all catalog changes when the audit fails",async () => {
    await sql("CREATE TRIGGER failed_write BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
    const before = await readFile(file);
    await expect(submit()).rejects.toThrow();
    expect((await readFile(file)).equals(before)).toBe(true);
  });

  it("baseline: leaves no partial catalog when a late field fails",async () => {
    await sql("CREATE TRIGGER failed_write BEFORE INSERT ON schema_fields WHEN NEW.field_name='line_id' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
    const before = await readFile(file);
    await expect(submit()).rejects.toThrow();
    expect((await readFile(file)).equals(before)).toBe(true);
  });

  it("baseline: refuses nontransactional storage before preparing any schema or catalog operation",async () => {
    const prepare = vi.fn(db.prepare), before = await readFile(file);
    expect(await importSchemaCatalog({ODAP_GATEWAY_DB:{prepare},DB:db},input,actor))
      .toMatchObject({ok:false,status:503,code:"schema_import_transaction_unavailable"});
    expect(prepare).not.toHaveBeenCalled();
    expect((await readFile(file)).equals(before)).toBe(true);
  });

  it("commits tables, fields and audit while retaining existing IDs and restrictive policy",async () => {
    const result = await submit();
    expect(result).toMatchObject({ok:true,value:{workspace:"fixture",importedTables:2,importedFields:3}});
    if (!result.ok) throw new Error("Expected confirmed import");
    expect(await counts()).toEqual({tables:{n:2},fields:{n:3},audits:{n:1}});
    expect(await jobSqlite(file,"readonly-first","SELECT * FROM schema_tables WHERE id='legacy-orders'"))
      .toEqual({id:"legacy-orders",workspace:"fixture",table_name:"fixture.orders",description:"Updated orders",row_count:9,updated_at:result.value.importedAt});
    expect(await jobSqlite(file,"readonly-first","SELECT * FROM schema_fields WHERE id='historical-contact'"))
      .toEqual({id:"historical-contact",table_id:"legacy-orders",field_name:"contact",field_type:"STRING",mode:"NULLABLE",
        description:"Updated contact",pii:1,queryable:0,used_in_examples:1,updated_at:result.value.importedAt});
    expect(await jobSqlite(file,"readonly-first","SELECT table_id,pii,queryable FROM schema_fields WHERE field_name='new_id'"))
      .toEqual({table_id:"legacy-orders",pii:0,queryable:1});
    expect(await jobSqlite(file,"readonly-first","SELECT actor_email,target,metadata_json,created_at FROM audit_events WHERE action='schema_catalog.imported'"))
      .toEqual({actor_email:"actor@example.test",target:"fixture",metadata_json:'{"importedTables":2,"importedFields":3}',created_at:result.value.importedAt});
    expect(fetch).not.toHaveBeenCalled();
  });

  it("persists explicit restrictions with their import audit on a previously queryable field", async () => {
    await sql("UPDATE schema_fields SET pii=0,queryable=1 WHERE id='historical-contact'");
    const restricted = structuredClone(input);
    Object.assign(restricted.tables[0].fields[0], { pii: true, queryable: false });
    expect(await importSchemaCatalog({ DB: db }, restricted, actor)).toMatchObject({ ok: true });
    expect(await jobSqlite(file, "readonly-first", "SELECT id,pii,queryable FROM schema_fields WHERE field_name='contact'"))
      .toEqual({ id: "historical-contact", pii: 1, queryable: 0 });
    const audit: { metadata_json: string } = await jobSqlite(file, "readonly-first",
      "SELECT metadata_json FROM audit_events WHERE action='schema_catalog.imported'");
    expect(JSON.parse(audit.metadata_json)).toEqual({ importedTables: 2, importedFields: 3,
      requestedRestrictions: [{ table: "fixture.orders", field: "contact", pii: true, queryable: false }] });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["BEFORE INSERT ON schema_tables","ABORT"],["BEFORE UPDATE ON schema_tables","ABORT"],
    ["BEFORE INSERT ON schema_fields","ABORT"],["BEFORE UPDATE ON schema_fields","ABORT"],
    ["BEFORE INSERT ON schema_tables","IGNORE"],["BEFORE UPDATE ON schema_tables","IGNORE"],
    ["BEFORE INSERT ON schema_fields","IGNORE"],["BEFORE UPDATE ON schema_fields","IGNORE"],
    ["BEFORE INSERT ON audit_events","IGNORE"]
  ])("aborts the whole import for %s with %s",async (clause,mode) => {
    await sql(`CREATE TRIGGER failed_write ${clause} BEGIN SELECT RAISE(${mode}${mode === "ABORT" ? ",'synthetic failure'" : ""}); END`);
    const before = await readFile(file);
    await expect(submit()).rejects.toThrow();
    expect((await readFile(file)).equals(before)).toBe(true);
  });

  it.each([false,true])("preserves a colliding historical audit, ignored=%s",async ignored => {
    if (ignored) await sql("CREATE TRIGGER failed_write BEFORE INSERT ON audit_events BEGIN SELECT RAISE(IGNORE); END");
    vi.spyOn(crypto,"randomUUID").mockReturnValue("prior-audit");
    const before = await readFile(file);
    await expect(submit()).rejects.toThrow();
    expect((await readFile(file)).equals(before)).toBe(true);
  });

  it("rolls back a field-ID slug collision instead of retaining earlier changes",async () => {
    const conflicting = structuredClone(input);
    conflicting.tables[1].fields.push({name:"line-id",type:"STRING",mode:"NULLABLE"});
    const before = await readFile(file);
    await expect(importSchemaCatalog({DB:db},conflicting,actor)).rejects.toThrow();
    expect((await readFile(file)).equals(before)).toBe(true);
  });

  it("refuses a concurrently introduced different table ID, then re-reads it on a later request",async () => {
    let concurrent!: Buffer;
    const spy = vi.spyOn(db,"batch").mockImplementationOnce(async statements => {
      await sql("INSERT INTO schema_tables VALUES ('concurrent-lines','fixture','fixture.lines','Concurrent table',3,'concurrent')");
      concurrent = await readFile(file);
      return base.batch!(statements);
    });
    await expect(submit()).rejects.toThrow();
    expect((await readFile(file)).equals(concurrent)).toBe(true);
    spy.mockRestore();
    expect(await submit()).toMatchObject({ok:true});
    expect(await jobSqlite(file,"readonly-first","SELECT table_id FROM schema_fields WHERE field_name='line_id'"))
      .toEqual({table_id:"concurrent-lines"});
  },20000);

  it("does not retry or compensate when the committed import loses its acknowledgment",async () => {
    const spy = vi.spyOn(db,"batch").mockImplementation(async statements => {
      await base.batch!(statements);throw new Error("Synthetic lost acknowledgment");
    });
    await expect(submit()).rejects.toThrow("Synthetic lost acknowledgment");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await counts()).toEqual({tables:{n:2},fields:{n:3},audits:{n:1}});
  });

  it("does not delete omitted fields or silently tighten/relax their existing policy on reimport",async () => {
    const subset = structuredClone(input);
    subset.tables = [subset.tables[0]];
    subset.tables[0].fields = [subset.tables[0].fields[1]];
    expect(await importSchemaCatalog({DB:db},subset,actor)).toMatchObject({ok:true,value:{importedTables:1,importedFields:1}});
    expect(await jobSqlite(file,"readonly-first","SELECT description,pii,queryable FROM schema_fields WHERE id='historical-contact'"))
      .toEqual({description:"Prior field",pii:1,queryable:0});
  });
});
