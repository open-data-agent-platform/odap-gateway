import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { onRequestPost } from "../functions/api/control/[tenant]/dispatch-stops";
import { jobDatabase, jobSqlite } from "./fixtures/job-sqlite";
import { dispatchStopCommandCases, dispatchStopRequest } from "./fixtures/dispatch-stop-command-cases";
import { recoveryCookie, recoveryEnv } from "./fixtures/delegated-recovery-request-cases";

let directory: string, file: string, template: string;
const db = jobDatabase(() => file);
const members = () => jobSqlite(file, "run", "INSERT INTO control_memberships VALUES('t','google:operator','owner',1),('t','google:owner','owner',1),('t','google:reader','reader',1)");
const call = async () => onRequestPost({ request: dispatchStopRequest(await recoveryCookie()), env: recoveryEnv(db), params: { tenant: "t" } });
describe("pre-dispatch stop HTTP on SQLite", { timeout: 30000 }, () => {
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "odap-stop-command-")); file = template = join(directory, "template.db");
    await jobSqlite(file,"setup"); await members();
  });
  beforeEach(async () => { file = join(directory,crypto.randomUUID()+".db"); await copyFile(template,file); });
  afterAll(async () => { if (directory) await rm(directory,{ recursive: true,force: true }); });
  dispatchStopCommandCases(() => db);
  it("supports initialized schema 0032 without adding tables or migrating", async () => {
    file = join(directory,crypto.randomUUID()+".db"); await jobSqlite(file,"setup-v32"); await members();
    const schema = await jobSqlite(file,"first","SELECT group_concat(sql) AS ddl FROM sqlite_master ORDER BY name");
    expect((await call()).status).toBe(200);
    expect(await jobSqlite(file,"first","SELECT group_concat(sql) AS ddl FROM sqlite_master ORDER BY name")).toEqual(schema);
  });
  it("refuses a schema without attributed stop support without changing bytes", async () => {
    file = join(directory,crypto.randomUUID()+".db"); await jobSqlite(file,"setup-v10"); await members();
    const before = await readFile(file); const response = await call(); expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false,code: "control_storage_unavailable" }); expect(await readFile(file)).toEqual(before);
  });
  it("does not backfill legacy stopper identity after an offline upgrade", async () => {
    file = join(directory,crypto.randomUUID()+".db"); await jobSqlite(file,"setup-v10"); await members();
    await jobSqlite(file,"run","INSERT INTO dispatch_stopped_intents VALUES('t','i','legacy')");
    await jobSqlite(file,"upgrade-v10-snapshot"); const before = await readFile(file);
    const response = await call(); expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ ok: false,code: "dispatch_stop_unavailable" }); expect(await readFile(file)).toEqual(before);
  });
});
